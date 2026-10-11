// ════════════════════════════════════════════════════════════════
// 24-backend-client.js — Cliente Cursia Backend (opcional / nube)
// Fase 4.1 — Cloud Save QA + Snapshot Safety
//
// Activación automática en producción:
//   - cursia.nomaddi.com → backend ON por defecto, sin configuración manual
//   - localhost/staging  → backend OFF por defecto, activable via localStorage
//
// Flags de override (localStorage):
//   CURSIA_BACKEND_DISABLED=true → forzar OFF en cualquier host (QA en prod)
//   CURSIA_BACKEND_ENABLED=true  → forzar ON  en localhost/staging
//   CURSIA_BACKEND_URL           → URL personalizada (dev/staging)
//
// Si el backend no responde → avisa al usuario, no rompe la app.
// ════════════════════════════════════════════════════════════════

(function () {

  // ──────────────────────────────────────────────────────────────
  // Estado global
  // ──────────────────────────────────────────────────────────────
  window.CURSIA_BACKEND = {
    enabled:   false,
    baseUrl:   'http://localhost:3000',
    status:    'unknown',   // 'unknown' | 'connected' | 'error' | 'disabled'
    lastError: null
  };

  // ──────────────────────────────────────────────────────────────
  // Resolución centralizada de configuración
  // ──────────────────────────────────────────────────────────────
  /**
   * Determina si el backend está activo y la URL que debe usar.
   *
   * Prioridad de resolución:
   *   1. CURSIA_BACKEND_DISABLED=true  → forzado OFF (override explícito, útil para QA en prod)
   *   2. CURSIA_BACKEND_ENABLED=true   → forzado ON  (override explícito, útil en localhost)
   *   3. hostname === 'cursia.nomaddi.com' → ON por defecto (producción)
   *   4. hostname === 'staging.orbia.pages.dev' → ON por defecto contra api-staging (entorno real
   *      de prueba sin claves manuales; antes caía al flujo legacy con un almacenamiento limpio)
   *   5. Cualquier otro host           → OFF por defecto (localhost / previews)
   *
   * La URL se resuelve en este orden:
   *   CURSIA_BACKEND_URL en localStorage → URL de producción en prod → api-staging en staging → localhost
   */
  function _resolveConfig() {
    var PROD_HOST = 'cursia.nomaddi.com';
    var PROD_URL  = 'https://api.cursia.nomaddi.com';
    var STAGING_HOST = 'staging.orbia.pages.dev';
    var STAGING_URL  = 'https://api-staging.cursia.nomaddi.com';
    var DEV_URL   = 'http://localhost:3000';
    var host      = (typeof window !== 'undefined' && window.location) ? window.location.hostname : '';
    var isProd    = (host === PROD_HOST);
    var isStaging = (host === STAGING_HOST);

    var disabled = false;
    var forceOn  = false;
    var localUrl = null;
    try {
      disabled = localStorage.getItem('CURSIA_BACKEND_DISABLED') === 'true';
      forceOn  = localStorage.getItem('CURSIA_BACKEND_ENABLED')  === 'true';
      localUrl = localStorage.getItem('CURSIA_BACKEND_URL')      || null;
    } catch (e) {}

    var defaultUrl = localUrl || (isProd ? PROD_URL : isStaging ? STAGING_URL : DEV_URL);

    // 1. Override explícito OFF
    if (disabled) {
      return { enabled: false, url: defaultUrl };
    }

    // 2. Override explícito ON
    if (forceOn) {
      return { enabled: true, url: defaultUrl };
    }

    // 3. Producción → ON automático
    // CURSIA_BACKEND_URL se respeta si está presente (útil para apuntar a staging desde prod)
    if (isProd) {
      return { enabled: true, url: localUrl || PROD_URL };
    }

    // 4. Staging → ON automático contra api-staging (CURSIA_BACKEND_URL se respeta si está)
    if (isStaging) {
      return { enabled: true, url: localUrl || STAGING_URL };
    }

    // 5. Otros entornos → OFF por defecto
    return { enabled: false, url: localUrl || DEV_URL };
  }

  // Inicializar configuración al cargar
  (function _initConfig() {
    try {
      var cfg = _resolveConfig();
      window.CURSIA_BACKEND.enabled = cfg.enabled;
      window.CURSIA_BACKEND.baseUrl = cfg.url;
      if (!cfg.enabled) window.CURSIA_BACKEND.status = 'disabled';
    } catch (e) {}
  })();

  // ── Feature flag: editor de estructura dinámica (Cursia V2) ───────────
  // window.DYNAMIC_COURSE_STRUCTURE_ENABLED es un valor DERIVADO (lo escribe
  // solo este bloque; el resto del código lo lee en el momento de usarlo).
  // Regla (fail-closed — cualquier otra combinación = OFF, flujo legacy tal
  // cual):
  //   (a) staging.orbia.pages.dev + localStorage.DYNAMIC_COURSE_STRUCTURE ===
  //       'true' → ON desde la carga (comportamiento de staging sin cambios;
  //       con solo el hostname, staging entero pasaba al editor dinámico y
  //       bloqueaba probar la generación legacy ahí). Tras setItem/removeItem
  //       hay que recargar.
  //   (b) cursia.nomaddi.com + usuario logueado cuyo GET /api/v1/features
  //       respondió 200 con dynamicCourseStructure === true (allow-list por
  //       cuenta del SERVIDOR), pedido EN ESTA CARGA DE PÁGINA. En producción
  //       la clave de localStorage NO tiene ningún efecto. 404/500/red/
  //       timeout/sin sesión/cuerpo raro → OFF.
  //   Ningún otro hostname puede activarlo.
  //
  // Encendido (producción): nunca antes de la respuesta — la pantalla legacy
  // se renderiza como siempre. Un ON pasa a V2 en caliente SOLO si:
  //   1. la restauración legacy del arranque ya terminó (14-ui.js emite
  //      'cursia:legacy-restore-done'; hasta entonces el ON queda pendiente),
  //   2. el usuario no interactuó con el flujo legacy en esta carga (ningún
  //      input/click/tecla dentro de Estructura, Producción o Generando, y ni
  //      Producción ni Generando visibles), y
  //   3. no hay estado legacy activo: COURSE_PRODUCTION distinto de 'idle' o
  //      restaurado, checkpoint de producción interrumpida, GENERATION_JOB
  //      activo/pausado/interrumpido, archivos del curso en F
  //      o un banner de "Sesión recuperada" (D NO cuenta: collect() lo
  //      llena siempre con el 3×3 por defecto). Ante cualquier duda
  //      (excepción al leer ese estado) → no.
  // Si no se cumple, el ON queda diferido (CURSIA_V2_GATE.deferred) hasta la
  // próxima carga — que vuelve a pedir /features y a evaluar todo.
  //
  // Apagado (kill switch): con V2 encendido por el servidor se re-consulta
  // /features cada 5 min con la pestaña visible y al volver a estar visible
  // (esto último, como mucho una vez por minuto). Esa re-consulta SOLO puede
  // apagar: ante un "no" definitivo (200 sin true, 401/403/404) de inmediato;
  // ante un fallo transitorio (red/timeout/5xx) tras UN reintento a los 30 s
  // que tampoco sea 200 + true. Al apagar se detienen
  // ejecutor y polling (sin claims nuevos; lo que está en vuelo termina solo),
  // se muestra "La nueva experiencia fue desactivada; vuelve a cargar la
  // página." y se pasa a legacy en el próximo punto seguro (sin mutaciones
  // en vuelo ni un campo en edición — dynV2SafeToSwitch en 43). Tras eso, esta
  // página no vuelve a encender V2 (CURSIA_V2_GATE.revoked).
  //
  // Caché: SOLO en memoria, por usuario y por vida de la página (evita
  // requests duplicados; nunca sobrevive a una recarga). Login/logout/cambio
  // de usuario la invalidan. window.dynFeatures() expone la misma respuesta a
  // 43 (única fuente de verdad para dynamicCourseStructure/realVideo).
  // Al cambiar el valor se emite window 'cursia:v2-flag-change'
  // ({detail:{enabled, reason}}); 43 escucha para instalar/soltar los guards
  // de Fase 2 y re-renderizar Estructura. Antes de un apagado por revocación
  // se emite 'cursia:v2-revoking' (43 detiene ejecutor/polling).
  var V2_STAGING_HOST = 'staging.orbia.pages.dev';
  var V2_PROD_HOST = 'cursia.nomaddi.com';
  var V2_RECHECK_MS = 5 * 60 * 1000;
  var V2_VISIBILITY_MIN_GAP_MS = 60 * 1000; // throttle del re-chequeo por visibilitychange
  var V2_TRANSIENT_RETRY_MS = 30 * 1000;    // único reintento ante un fallo transitorio del re-chequeo
  var V2_SAFE_POINT_POLL_MS = 500;
  var V2_REVOKED_MSG = 'La nueva experiencia fue desactivada; vuelve a cargar la página.';

  function _v2Host() {
    try { return (window.location && window.location.hostname) || ''; } catch (e) { return ''; }
  }

  window.CURSIA_V2_GATE = {
    source: 'off',        // 'staging' | 'server' | 'off'
    state: 'idle',        // 'idle' | 'not-applicable' | 'signed-out' | 'loading' | 'ok' | 'error'
    userId: null,         // usuario al que corresponde el último estado
    features: null,       // {dynamicCourseStructure, realVideo} de un 200 | null
    pendingOn: false,     // ON recibido, esperando que termine la restauración legacy del arranque
    deferred: false,      // ON recibido pero no se pudo aplicar en caliente → próxima carga
    deferReason: null,    // 'interaction' | 'legacy-state' | null
    legacyTouched: false, // hubo interacción con el flujo legacy en esta carga
    revoked: false        // el servidor apagó V2 durante esta carga → no vuelve a encender
  };

  // Staging: un override EXPLÍCITO en localStorage manda (DYNAMIC_COURSE_STRUCTURE='true' → ON,
  // 'false' → OFF fijo). Sin override, staging decide igual que producción: GET /features con la
  // protección de estado legacy (antes staging sin la clave quedaba siempre en legacy).
  function _v2StagingOverride() {
    try {
      if (_v2Host() !== V2_STAGING_HOST) return null;
      var v = window.localStorage.getItem('DYNAMIC_COURSE_STRUCTURE');
      return v === 'true' ? true : v === 'false' ? false : null;
    } catch (e) {
      return null;
    }
  }
  window.DYNAMIC_COURSE_STRUCTURE_ENABLED = (function () {
    var o = _v2StagingOverride();
    if (o === true) window.CURSIA_V2_GATE.source = 'staging';
    return o === true;
  })();

  function _v2Emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) {}
  }

  function _v2SetFlag(on, reason) {
    on = on === true;
    if (window.DYNAMIC_COURSE_STRUCTURE_ENABLED === on) return;
    window.DYNAMIC_COURSE_STRUCTURE_ENABLED = on;
    window.CURSIA_V2_GATE.source = on ? 'server' : 'off';
    if (on) _v2StartRecheck(); else _v2StopRecheck();
    _v2Emit('cursia:v2-flag-change', { enabled: on, reason: reason });
  }

  // ── /features: una respuesta por usuario y por vida de la página ──
  var _v2Mem = { uid: null, result: null, promise: null };

  function _v2UidNow() {
    return (window.SB_USER && window.SB_USER.id) ? String(window.SB_USER.id) : null;
  }

  function _v2Is200(r) {
    return !!(r && r.ok === true && r._httpStatus === 200 && r.data && typeof r.data === 'object');
  }

  var _v2LastCheckAt = 0; // inicio del último GET /features (cualquier origen)

  function _v2RawGetFeatures() {
    _v2LastCheckAt = Date.now();
    var getter = (typeof window.backendGetFeatures === 'function') ? window.backendGetFeatures : backendGetFeatures;
    return Promise.resolve().then(function () { return getter(); }).then(null, function (e) {
      return { ok: false, error: (e && e.message) || 'Error de red', _httpStatus: null };
    });
  }

  /**
   * Resultado crudo de GET /api/v1/features ({ok,data,_httpStatus,...}) para
   * el usuario actual. Memoizado en memoria (solo 200) durante la vida de la
   * página; requests concurrentes comparten el mismo vuelo. opts.fresh = true
   * ignora el memo (re-chequeo del kill switch) y lo actualiza si es 200.
   */
  function dynFeatures(opts) {
    var uid = _v2UidNow();
    var fresh = !!(opts && opts.fresh);
    if (_v2Mem.uid !== uid) _v2Mem = { uid: uid, result: null, promise: null };
    if (!fresh && _v2Mem.result) return Promise.resolve(_v2Mem.result);
    if (!fresh && _v2Mem.promise) return _v2Mem.promise;
    var mem = _v2Mem;
    var p = _v2RawGetFeatures().then(function (r) {
      if (mem === _v2Mem && _v2UidNow() === uid) {
        if (_v2Is200(r)) mem.result = r;
        else if (fresh) mem.result = null; // nunca servir un ON viejo después de un apagado
      }
      if (mem.promise === p) mem.promise = null;
      return r;
    });
    mem.promise = p;
    return p;
  }
  window.dynFeatures = dynFeatures;

  function _v2FeaturesFrom(r) {
    return {
      dynamicCourseStructure: r.data.dynamicCourseStructure === true,
      realVideo: r.data.realVideo === true
    };
  }

  // Paneles del flujo legacy cuya interacción "compromete" la sesión.
  var V2_LEGACY_PANELS = ['panel-estructura', 'panel-produccion', 'panel-generando'];

  function _v2LegacyGenerationPanelVisible() {
    for (var i = 1; i < V2_LEGACY_PANELS.length; i++) {
      var p = document.getElementById(V2_LEGACY_PANELS[i]);
      if (p && p.classList && p.classList.contains('on')) return true;
    }
    return false;
  }

  // ¿Hay un curso/generación legacy cargado o en curso? Solo artefactos reales
  // de un curso legacy. Ante cualquier duda (excepción) → true.
  function _v2LegacyStateActive() {
    try {
      var cp = window.COURSE_PRODUCTION;
      if (cp && ((cp.status && cp.status !== 'idle') || cp._restored)) return true;
      if (typeof window.cpHasInterruptedProduction === 'function' && window.cpHasInterruptedProduction()) return true;
      var gj = window.GENERATION_JOB;
      if (gj && (gj.active === true || ['running', 'paused', 'interrupted'].indexOf(gj.status) !== -1)) return true;
      var f = window.F;
      if (f && typeof f === 'object' && Object.keys(f).length > 0) return true;
      // D.mods/D.caps NO cuentan: collect() (01-state.js) arma siempre el 3×3
      // por defecto y corre en casi cualquier go() (updSidebarStatus →
      // updDashboard). Un curso legacy real deja rastro en F / producción /
      // GENERATION_JOB / banners de restauración.
      if (document.getElementById('restore-banner') || document.getElementById('cp-restore-banner')) return true;
      return false;
    } catch (e) {
      return true;
    }
  }

  // La restauración legacy del arranque (autoLoad de 14-ui.js: F desde
  // IndexedDB + GENERATION_JOB) es asíncrona. Hasta que termine no se puede
  // saber si hay un curso legacy cargado → el ON espera. Sin autoLoad (p. ej.
  // un entorno sin 01-state.js) no hay nada que esperar.
  function _v2LegacyRestoreSettled() {
    return window.CURSIA_LEGACY_RESTORE_DONE === true || typeof window.autoLoad !== 'function';
  }

  // Registra interacción del usuario con el flujo legacy mientras V2 está OFF.
  (function _v2TrackLegacyInteraction() {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    function onEvt(e) {
      if (window.DYNAMIC_COURSE_STRUCTURE_ENABLED || window.CURSIA_V2_GATE.legacyTouched) return;
      var t = e && e.target;
      if (!t || !t.closest) return;
      for (var i = 0; i < V2_LEGACY_PANELS.length; i++) {
        if (t.closest('#' + V2_LEGACY_PANELS[i])) { window.CURSIA_V2_GATE.legacyTouched = true; return; }
      }
    }
    ['input', 'change', 'click', 'keydown', 'pointerdown'].forEach(function (type) {
      document.addEventListener(type, onEvt, true);
    });
  })();

  function _v2ApplyServerAnswer(features) {
    var g = window.CURSIA_V2_GATE;
    g.features = features;
    if (!features || features.dynamicCourseStructure !== true) {
      g.pendingOn = false; g.deferred = false; g.deferReason = null;
      _v2SetFlag(false, 'server-off');
      return;
    }
    if (window.DYNAMIC_COURSE_STRUCTURE_ENABLED || g.revoked) return;
    if (g.deferred) return; // diferido: se re-evalúa recién en la próxima carga (o con otro usuario)
    if (!_v2LegacyRestoreSettled()) { g.pendingOn = true; return; }
    g.pendingOn = false;
    var reason = null;
    if (g.legacyTouched || _v2LegacyGenerationPanelVisible()) reason = 'interaction';
    else if (_v2LegacyStateActive()) reason = 'legacy-state';
    if (reason) {
      g.deferred = true; g.deferReason = reason; // la próxima carga vuelve a pedir /features
      return;
    }
    g.deferred = false; g.deferReason = null;
    _v2SetFlag(true, 'server-on');
  }

  // "Nuevo curso" (solo staging; producción sin cambios): el diferimiento por estado legacy protege
  // un curso legacy EN CURSO; un curso nuevo no debe heredarlo. Tras nuevoCurso() (id nuevo, F vacío,
  // banner fuera) se re-evalúa ignorando lo que pertenece al curso ANTERIOR: COURSE_PRODUCTION no se
  // resetea en nuevoCurso ni guarda id → solo bloquea si sigue viva ('running' o pausada); un checkpoint interrumpido
  // bloquea solo si es del curso nuevo. La interacción previa con los paneles legacy tampoco cuenta.
  // Nunca enciende si el servidor no dijo ON, con override explícito, revocado, restauración legacy
  // sin terminar o estado legacy del curso nuevo.
  function _v2LegacyStateActiveFor(courseId) {
    try {
      var cp = window.COURSE_PRODUCTION;
      // viva en la página: 'running' o pausada (el orquestador sigue esperando y se puede reanudar)
      if (cp && (cp.status === 'running' || cp.status === 'paused' || cp._pause === true)) return true;
      if (typeof window.cpHasInterruptedProduction === 'function' && window.cpHasInterruptedProduction()) {
        var ck = (typeof window.cpLoadCheckpoint === 'function') ? window.cpLoadCheckpoint() : null;
        if (!ck || !ck.courseId || ck.courseId === courseId) return true;
      }
      var gj = window.GENERATION_JOB;
      if (gj && (gj.active === true || ['running', 'paused', 'interrupted'].indexOf(gj.status) !== -1)) return true;
      var f = window.F;
      if (f && typeof f === 'object' && Object.keys(f).length > 0) return true;
      if (document.getElementById('restore-banner') || document.getElementById('cp-restore-banner')) return true;
      return false;
    } catch (e) {
      return true;
    }
  }
  function cursiaV2OnNewCourse() {
    var g = window.CURSIA_V2_GATE;
    var host = _v2Host();
    if (host !== V2_STAGING_HOST) return false; // producción: sin cambios (el diferido espera a la próxima carga)
    if (_v2StagingOverride() !== null) return false;
    if (window.DYNAMIC_COURSE_STRUCTURE_ENABLED || g.revoked) return !!window.DYNAMIC_COURSE_STRUCTURE_ENABLED;
    if (!g.features || g.features.dynamicCourseStructure !== true) return false;
    if (!_v2LegacyRestoreSettled()) return false; // una restauración legacy en vuelo podría volver a llenar F
    if (_v2LegacyGenerationPanelVisible()) return false;
    if (_v2LegacyStateActiveFor(window.ACTIVE_COURSE_ID)) return false;
    g.deferred = false; g.deferReason = null; g.legacyTouched = false;
    _v2SetFlag(true, 'new-course');
    return true;
  }
  window.cursiaV2OnNewCourse = cursiaV2OnNewCourse;
  (function _v2HookNewCourse() {
    var orig = window.nuevoCurso; // 01-state.js (carga antes); los onclick lo resuelven por nombre global
    if (typeof orig !== 'function') return;
    window.nuevoCurso = function () {
      var before = window.ACTIVE_COURSE_ID;
      var r = orig.apply(this, arguments);
      try { if (window.ACTIVE_COURSE_ID !== before) cursiaV2OnNewCourse(); } catch (e) {}
      return r;
    };
  })();

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('cursia:legacy-restore-done', function () {
      var g = window.CURSIA_V2_GATE;
      if (g.pendingOn && g.features && g.userId === _v2UidNow()) _v2ApplyServerAnswer(g.features);
    });
  }

  var _v2Seq = 0;

  /**
   * (Re)evalúa el flag para el usuario actual (window.SB_USER). Lo llama
   * 20-supabase.js al activar una sesión, al cerrar sesión, ante SIGNED_OUT y
   * TOKEN_REFRESHED, y este archivo al cargar si la sesión ya estaba activa.
   * Idempotente. Devuelve una promesa que resuelve cuando el estado quedó
   * aplicado.
   */
  function cursiaV2FeaturesRefresh() {
    var g = window.CURSIA_V2_GATE;
    var host = _v2Host();
    // staging con override explícito en localStorage: sin cambios (lo decide la clave)
    if (host === V2_STAGING_HOST && _v2StagingOverride() !== null) return Promise.resolve(window.DYNAMIC_COURSE_STRUCTURE_ENABLED);
    if (host !== V2_PROD_HOST && host !== V2_STAGING_HOST) {
      g.state = 'not-applicable';
      _v2SetFlag(false, 'host');
      return Promise.resolve(false);
    }

    var uid = _v2UidNow();
    var seq = ++_v2Seq;
    if (uid !== g.userId) {
      // Login / logout / cambio de usuario → memo fuera y OFF inmediato
      // hasta tener la respuesta del usuario nuevo.
      _v2Mem = { uid: uid, result: null, promise: null };
      g.userId = uid;
      g.features = null;
      g.pendingOn = false; g.deferred = false; g.deferReason = null;
      _v2SetFlag(false, uid ? 'user-change' : 'signed-out');
    }
    if (!uid) { g.state = 'signed-out'; return Promise.resolve(false); }

    // Mismo usuario con V2 ya encendido por el servidor, o ya revocado en esta
    // carga (p. ej. TOKEN_REFRESHED): el apagado lo decide SOLO el kill switch
    // (cursiaV2Recheck → _v2Revoke → punto seguro), nunca un refresh — así no
    // se saltea el punto seguro ni se pierde un campo en edición.
    if (g.revoked || (window.DYNAMIC_COURSE_STRUCTURE_ENABLED && g.source === 'server')) {
      return Promise.resolve(window.DYNAMIC_COURSE_STRUCTURE_ENABLED);
    }

    if (!_v2Mem.result) g.state = 'loading';
    return dynFeatures().then(function (r) {
      if (seq !== _v2Seq || _v2UidNow() !== uid) return window.DYNAMIC_COURSE_STRUCTURE_ENABLED; // respuesta vieja
      if (_v2Is200(r)) {
        g.state = 'ok';
        _v2ApplyServerAnswer(_v2FeaturesFrom(r));
      } else {
        g.state = 'error';
        g.features = null;
        g.pendingOn = false; g.deferred = false; g.deferReason = null;
        _v2SetFlag(false, 'features-error');
      }
      return window.DYNAMIC_COURSE_STRUCTURE_ENABLED;
    });
  }
  window.cursiaV2FeaturesRefresh = cursiaV2FeaturesRefresh;

  // ── Kill switch: re-chequeo periódico (solo puede APAGAR) ──
  var _v2RecheckTimer = null;
  var _v2RecheckInFlight = false;

  function _v2Visible() {
    try { return !document.visibilityState || document.visibilityState === 'visible'; } catch (e) { return true; }
  }

  function _v2StartRecheck() {
    if (_v2RecheckTimer || window.CURSIA_V2_GATE.source !== 'server') return;
    _v2RecheckTimer = setInterval(function () { if (_v2Visible()) cursiaV2Recheck(); }, V2_RECHECK_MS);
  }

  function _v2StopRecheck() {
    if (_v2RecheckTimer) { clearInterval(_v2RecheckTimer); _v2RecheckTimer = null; }
  }

  var _v2RetryPending = false;

  // ¿La respuesta del re-chequeo es un "no" definitivo? 200 sin
  // dynamicCourseStructure === true, 401, 403, 404 (y cualquier otro 4xx salvo
  // 408/429) → sí. Red, timeout, sin sesión (no_session), 408, 429 y 5xx →
  // transitorio: se reintenta UNA vez antes de revocar.
  function _v2IsDefinitiveOff(r) {
    if (_v2Is200(r)) return true; // (el caso true ya se descartó)
    var st = r && r._httpStatus;
    if (typeof st !== 'number') return false;
    if (st >= 500) return false;
    if (st === 408 || st === 429) return false;
    return st >= 400;
  }

  function _v2RecheckOnce(uid) {
    var g = window.CURSIA_V2_GATE;
    _v2RecheckInFlight = true;
    return dynFeatures({ fresh: true }).then(function (r) {
      _v2RecheckInFlight = false;
      if (_v2UidNow() !== uid || !window.DYNAMIC_COURSE_STRUCTURE_ENABLED || g.revoked) return { stale: true };
      if (_v2Is200(r)) {
        var f = _v2FeaturesFrom(r);
        g.features = f;
        if (f.dynamicCourseStructure === true) return { on: true };
      }
      return { on: false, definitive: _v2IsDefinitiveOff(r), r: r };
    });
  }

  /**
   * Re-consulta /features sin memo (kill switch; solo puede APAGAR).
   * 200 + true → sigue. "No" definitivo → revoca ya. Fallo transitorio → un
   * único reintento a los 30 s; revoca solo si ese reintento tampoco es
   * 200 + true. Mientras hay un reintento pendiente no se re-chequea.
   */
  function cursiaV2Recheck() {
    var g = window.CURSIA_V2_GATE;
    if (!window.DYNAMIC_COURSE_STRUCTURE_ENABLED || g.source !== 'server' || g.revoked || _v2RecheckInFlight || _v2RetryPending) {
      return Promise.resolve(window.DYNAMIC_COURSE_STRUCTURE_ENABLED);
    }
    var uid = _v2UidNow();
    return _v2RecheckOnce(uid).then(function (res) {
      if (res.stale || res.on) return window.DYNAMIC_COURSE_STRUCTURE_ENABLED;
      if (res.definitive) { _v2Revoke('server-off'); return window.DYNAMIC_COURSE_STRUCTURE_ENABLED; }
      _v2RetryPending = true;
      setTimeout(function () {
        if (_v2UidNow() !== uid || !window.DYNAMIC_COURSE_STRUCTURE_ENABLED || g.revoked) { _v2RetryPending = false; return; }
        _v2RecheckOnce(uid).then(function (res2) {
          _v2RetryPending = false;
          if (res2.stale || res2.on) return;
          // staging: un fallo transitorio (p. ej. un deploy) nunca revoca; el próximo ciclo re-consulta
          if (!res2.definitive && _v2Host() === V2_STAGING_HOST) return;
          _v2Revoke(res2.definitive ? 'server-off' : 'features-error');
        });
      }, V2_TRANSIENT_RETRY_MS);
      return window.DYNAMIC_COURSE_STRUCTURE_ENABLED;
    });
  }
  window.cursiaV2Recheck = cursiaV2Recheck;

  // visibilitychange → visible: re-chequeo con throttle (no más de uno cada
  // 60 s contando cualquier GET /features); el timer de 5 min y la llamada
  // manual a cursiaV2Recheck() no pasan por este throttle.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (!_v2Visible()) return;
      if (Date.now() - _v2LastCheckAt < V2_VISIBILITY_MIN_GAP_MS) return;
      cursiaV2Recheck();
    });
  }

  function _v2ShowRevokedNotice() {
    try {
      if (document.getElementById('cursia-v2-revoked-notice')) return;
      var el = document.createElement('div');
      el.id = 'cursia-v2-revoked-notice';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:10000;' +
        'max-width:calc(100% - 32px);box-sizing:border-box;padding:12px 16px;border-radius:10px;' +
        'background:#1f2937;color:#fff;font:inherit;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,.3);';
      el.textContent = V2_REVOKED_MSG;
      document.body.appendChild(el);
    } catch (e) {}
  }

  function _v2SwitchOffWhenSafe() {
    if (!window.DYNAMIC_COURSE_STRUCTURE_ENABLED) return;
    var safe = true;
    try { if (typeof window.dynV2SafeToSwitch === 'function') safe = window.dynV2SafeToSwitch() === true; } catch (e) { safe = true; }
    if (safe) _v2SetFlag(false, 'revoked');
    else setTimeout(_v2SwitchOffWhenSafe, V2_SAFE_POINT_POLL_MS);
  }

  function _v2Revoke(reason) {
    var g = window.CURSIA_V2_GATE;
    if (g.revoked) return;
    g.revoked = true;
    g.pendingOn = false; g.deferred = false; g.deferReason = null;
    _v2StopRecheck();
    _v2Emit('cursia:v2-revoking', { reason: reason }); // 43: detener ejecutor y polling ya
    _v2ShowRevokedNotice();
    _v2SwitchOffWhenSafe();
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers internos
  // ──────────────────────────────────────────────────────────────

  function _baseUrl() {
    return (window.CURSIA_BACKEND.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
  }

  // ── Request logging ─────────────────────────────────────────
  var _reqCounter = 0;

  /** Genera un request_id corto y único por sesión */
  function _genRequestId() {
    _reqCounter++;
    return 'req_' + Date.now().toString(36) + '_' + _reqCounter;
  }

  /**
   * Clasifica el tipo de error de un fetch fallido.
   * Devuelve: 'timeout' | 'network' | 'auth' | 'http_error' | 'unknown'
   */
  function _classifyFetchError(errorMsg, httpStatus) {
    if (!errorMsg && !httpStatus) return 'unknown';
    var msg = String(errorMsg || '').toLowerCase();

    if (msg.indexOf('timeout') !== -1 || msg.indexOf('abort') !== -1)
      return 'timeout';
    if (/fetch|network|econnreset|econnrefused|enotfound|socket|net::err|load failed|connection/i.test(msg))
      return 'network';
    if (httpStatus === 401 || httpStatus === 403 || msg.indexOf('no_session') !== -1)
      return 'auth';
    if (httpStatus && httpStatus >= 400)
      return 'http_error';
    return 'unknown';
  }

  /**
   * Obtiene contexto del curso/usuario actual para enriquecer logs.
   * Nunca imprime tokens.
   */
  function _getLogContext() {
    var ctx = {};
    try {
      if (window.SB_USER && window.SB_USER.id) ctx.user_id = window.SB_USER.id;
      var d = (typeof D !== 'undefined') ? D : null;
      if (d) {
        if (d.backendCourseId) ctx.course_id = d.backendCourseId;
        if (d.nombre)          ctx.course_name = d.nombre;
      }
    } catch (e) {}
    return ctx;
  }

  /** Ringbuffer de los últimos 50 requests (para diagnóstico en consola) */
  var _requestLog = [];
  var _REQUEST_LOG_MAX = 50;

  /**
   * Registra un request en el log circular y lo imprime en consola.
   * @param {object} entry — { request_id, endpoint, method, status, duration_ms, error, error_type, ... }
   */
  function _logRequest(entry) {
    _requestLog.push(entry);
    if (_requestLog.length > _REQUEST_LOG_MAX) _requestLog.shift();

    // Console output: compact para éxito, verbose para error
    var tag = '[Cursia:req]';
    if (entry.ok) {
      console.log(tag, entry.request_id, entry.method || 'GET', entry.endpoint,
        '→', entry.status || 200, '(' + entry.duration_ms + 'ms)');
    } else if (entry.quiet) {
      // #583 (N8): sondeo que reintenta solo con espera creciente — sin advertencia en la consola.
      if (console.debug) console.debug(tag, entry.request_id, entry.method || 'GET', entry.endpoint, '→', entry.status || entry.error_type || '?', '(sondeo, se reintenta)');
    } else {
      console.warn(tag, entry.request_id, entry.method || 'GET', entry.endpoint,
        '→ ERROR', entry.error_type || '?', ':', entry.error,
        '(' + entry.duration_ms + 'ms)',
        entry.user_id ? 'user=' + entry.user_id : '',
        entry.course_id ? 'course=' + entry.course_id : '');
    }
  }

  /**
   * fetch con timeout configurable (default 8 s para GETs y lecturas, 30 s para writes).
   * Siempre resuelve — nunca lanza.
   * Devuelve { ok, data, _meta } o { ok: false, error, errorType, _meta }
   *
   * _meta contiene: request_id, endpoint, duration_ms, error_type
   *
   * @param {string} url
   * @param {object} [options]
   * @param {number} [timeoutMs=8000] — timeout en ms; usar 30000 para endpoints de escritura lentos
   */
  function _fetchWithTimeout(url, options, timeoutMs) {
    var requestId  = _genRequestId();
    var startTime  = Date.now();
    var endpoint   = url.replace(_baseUrl(), '') || url;
    var method     = (options && options.method) || 'GET';
    var quiet      = !!(options && options._quiet);
    if (quiet) { options = Object.assign({}, options); delete options._quiet; }
    var effectiveTimeout = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 8000;
    var timeoutLabel = effectiveTimeout >= 1000
      ? Math.round(effectiveTimeout / 1000) + ' s'
      : effectiveTimeout + ' ms';

    return new Promise(function (resolve) {
      var controller = null;
      var timer = null;

      function _resolve(result) {
        var duration = Date.now() - startTime;
        var httpStatus = result._httpStatus || null;
        var errorType  = result.ok ? null : _classifyFetchError(result.error, httpStatus);
        var ctx        = result.ok ? {} : _getLogContext();

        // Enrich result with metadata
        result._meta = {
          request_id:  requestId,
          endpoint:    endpoint,
          method:      method,
          duration_ms: duration,
          error_type:  errorType
        };
        if (errorType) result.errorType = errorType;

        // Log
        _logRequest(Object.assign({
          quiet:       quiet,
          request_id:  requestId,
          endpoint:    endpoint,
          method:      method,
          ok:          result.ok,
          status:      httpStatus,
          duration_ms: duration,
          error:       result.error || null,
          error_type:  errorType,
          timestamp:   new Date().toISOString()
        }, ctx));

        resolve(result);
      }

      try {
        controller = new AbortController();
        timer = setTimeout(function () {
          controller.abort();
          _resolve({ ok: false, error: 'Timeout: el backend no respondió en ' + timeoutLabel, _httpStatus: null });
        }, effectiveTimeout);

        fetch(url, Object.assign({}, options || {}, { signal: controller.signal }))
          .then(function (res) {
            clearTimeout(timer);
            if (!res.ok) {
              return res.json().catch(function () { return {}; }).then(function (body) {
                // Prebrief: el cuerpo del error (code, reason, blockers, diff…) para explicarlo en la interfaz.
                _resolve({ ok: false, error: (body && body.error) || ('HTTP ' + res.status), _httpStatus: res.status, errorBody: body && typeof body === 'object' ? body : null });
              });
            }
            return res.json().then(function (json) {
              _resolve({ ok: true, data: json.data !== undefined ? json.data : json, _httpStatus: res.status });
            });
          })
          .catch(function (err) {
            clearTimeout(timer);
            if (err && err.name === 'AbortError') return; // timer already resolved
            _resolve({ ok: false, error: err ? (err.message || String(err)) : 'Error de red', _httpStatus: null });
          });
      } catch (err) {
        if (timer) clearTimeout(timer);
        _resolve({ ok: false, error: err ? (err.message || String(err)) : 'Error inesperado', _httpStatus: null });
      }
    });
  }

  /**
   * Cuando un fetch no-health falla con error de red o timeout,
   * sondea /health para distinguir "red momentánea" de "backend caído".
   *
   * Actualiza CURSIA_BACKEND.status según el resultado.
   * @param {object} failedResult — resultado de _fetchWithTimeout que falló
   * @returns {Promise<object>} — el mismo failedResult, enriquecido con .backendAlive
   */
  function _probeHealthOnFailure(failedResult) {
    var errorType = failedResult.errorType || 'unknown';
    // Solo sondear para errores de red/timeout (no auth ni HTTP 4xx/5xx)
    if (errorType !== 'network' && errorType !== 'timeout') {
      return Promise.resolve(failedResult);
    }
    // No sondear si el request que falló ya era al /health
    var meta = failedResult._meta || {};
    if (meta.endpoint === '/health') {
      window.CURSIA_BACKEND.status = 'error';
      failedResult.backendAlive = false;
      return Promise.resolve(failedResult);
    }

    console.log('[Cursia:probe]', meta.request_id, 'Fetch falló (' + errorType + '), sondeando /health…');

    return _fetchWithTimeout(_baseUrl() + '/health').then(function (healthRes) {
      if (healthRes.ok) {
        // Backend vive — fue un problema de red momentáneo
        console.log('[Cursia:probe]', meta.request_id, '/health OK → backend vivo, error fue transitorio');
        window.CURSIA_BACKEND.status    = 'connected';
        window.CURSIA_BACKEND.lastError = null;
        failedResult.backendAlive = true;
        failedResult.error = failedResult.error + ' (backend vivo, error de red transitorio)';
      } else {
        // Backend no responde
        console.warn('[Cursia:probe]', meta.request_id, '/health falló → backend caído o inalcanzable');
        window.CURSIA_BACKEND.status    = 'error';
        window.CURSIA_BACKEND.lastError = 'Backend no responde';
        failedResult.backendAlive = false;
        failedResult.error = 'Backend no responde (verificado con /health)';
        failedResult.errorType = 'backend_down';
      }
      return failedResult;
    });
  }

  /** Devuelve copia del log de requests (para diagnóstico en consola: _getRequestLog()) */
  function _getRequestLog() {
    return _requestLog.slice();
  }

  /** Escape básico para HTML inline */
  function _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Tamaño en bytes de un objeto serializable */
  function _jsonBytes(obj) {
    try { return new Blob([JSON.stringify(obj)]).size; } catch (e) {
      try { return JSON.stringify(obj).length; } catch (e2) { return 0; }
    }
  }

  /** Bytes → texto legible */
  function _humanSize(bytes) {
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1048576)     return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824)  return (bytes / 1048576).toFixed(2) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  // ──────────────────────────────────────────────────────────────
  // NUEVA — backendEstimateSnapshotSize(snapshot)
  // ──────────────────────────────────────────────────────────────
  /**
   * Estima el tamaño de un snapshot antes de enviarlo.
   * @param {object} snapshot — objeto con D, F, MEDIA, VIDEO_ENGINE, metadata
   * @returns {{ bytes, human, fKeysCount, mediaVideosCount, mediaAudioCount, hasLargeFiles, largeFileKeys }}
   */
  function backendEstimateSnapshotSize(snapshot) {
    var snap = snapshot || {};
    var fObj  = snap.F  || {};
    var med   = snap.MEDIA || {};

    var bytes = _jsonBytes(snap);
    var fKeys = Object.keys(fObj);

    // Detectar archivos grandes en F (> 512 KB individuales)
    var largeFileKeys = [];
    fKeys.forEach(function (k) {
      var val = fObj[k];
      if (typeof val === 'string') {
        var kb = val.length / 1024;
        if (kb > 512) largeFileKeys.push({ key: k, sizeKB: Math.round(kb) });
      }
    });

    // Contar videos en MEDIA.videos
    var videosObj   = (med.videos && typeof med.videos === 'object') ? med.videos : {};
    var videosCount = Object.keys(videosObj).filter(function (k) {
      return videosObj[k] && videosObj[k] !== null;
    }).length;

    // Contar audios (audio puede ser url string o array)
    var audioCount = 0;
    if (med.audio)       audioCount++;
    if (med.audiolibro)  audioCount++;

    return {
      bytes:            bytes,
      human:            _humanSize(bytes),
      fKeysCount:       fKeys.length,
      mediaVideosCount: videosCount,
      mediaAudioCount:  audioCount,
      hasLargeFiles:    largeFileKeys.length > 0,
      largeFileKeys:    largeFileKeys
    };
  }

  // ──────────────────────────────────────────────────────────────
  // NUEVA — backendBuildSnapshot()
  // ──────────────────────────────────────────────────────────────
  /**
   * Construye el snapshot de forma explícita y segura.
   *
   * Preserva: D, F, MEDIA, VIDEO_ENGINE
   * Excluye de VIDEO_ENGINE: campo 'polling' (timer ID, sin valor para backup)
   * Excluye de D: backendCloudMeta (meta interna que se regenera, no circular)
   * No excluye ningún archivo de F por defecto — si el usuario generó algo, lo guardamos.
   *
   * @returns {{ D, F, MEDIA, VIDEO_ENGINE, metadata, _estimate }}
   */
  function backendBuildSnapshot() {
    // Leer estado actual con fallbacks seguros
    var rawD  = (typeof D !== 'undefined' ? D : null)            || {};
    var rawF  = (typeof F !== 'undefined' ? F : null)            || {};
    var rawM  = (typeof MEDIA !== 'undefined' ? MEDIA : null)    || {};
    var rawVE = (window.VIDEO_ENGINE)                             || {};

    // ── D: copia sin backendCloudMeta (meta redundante, se reconstruye)
    var safeD = {};
    Object.keys(rawD).forEach(function (k) {
      if (k !== 'backendCloudMeta') safeD[k] = rawD[k];
    });

    // ── F: completo — los archivos son el valor principal del backup
    var safeF = {};
    Object.keys(rawF).forEach(function (k) { safeF[k] = rawF[k]; });

    // ── MEDIA: completo
    var safeMEDIA = {};
    Object.keys(rawM).forEach(function (k) { safeMEDIA[k] = rawM[k]; });

    // ── VIDEO_ENGINE: excluir 'polling' (timer/interval ID)
    var safeVE = {};
    Object.keys(rawVE).forEach(function (k) {
      if (k !== 'polling') safeVE[k] = rawVE[k];
    });

    var partial = { D: safeD, F: safeF, MEDIA: safeMEDIA, VIDEO_ENGINE: safeVE };
    var estimate = backendEstimateSnapshotSize(partial);

    // ── Metadata enriquecida (Fase 4.1 req #3)
    var meta = {
      saved_from:          'cursia_frontend',
      saved_at:            new Date().toISOString(),
      mode:                'manual_cloud_save',
      app_url:             (typeof location !== 'undefined' ? location.href : ''),
      backend_url:         _baseUrl(),
      snapshot_size_bytes: estimate.bytes,
      snapshot_size_human: estimate.human,
      f_keys_count:        estimate.fKeysCount,
      media_videos_count:  estimate.mediaVideosCount,
      media_audio_count:   estimate.mediaAudioCount
    };

    return {
      D:            safeD,
      F:            safeF,
      MEDIA:        safeMEDIA,
      VIDEO_ENGINE: safeVE,
      metadata:     meta,
      _estimate:    estimate   // campo interno, no se envía al backend (se quita antes del POST)
    };
  }

  // ──────────────────────────────────────────────────────────────
  // API pública — configuración
  // ──────────────────────────────────────────────────────────────

  function backendConfigure() {
    try {
      var cfg = _resolveConfig();
      window.CURSIA_BACKEND.enabled = cfg.enabled;
      window.CURSIA_BACKEND.baseUrl = cfg.url;
      if (!cfg.enabled) window.CURSIA_BACKEND.status = 'disabled';
    } catch (e) {}
  }

  function backendIsEnabled() {
    return window.CURSIA_BACKEND.enabled === true;
  }

  function backendGetBaseUrl() {
    return _baseUrl();
  }

  function _canAccessBackendPanel() {
    return !!(
      typeof window.canUseAdvancedMode === 'function' &&
      typeof window.isAdvancedMode === 'function' &&
      window.canUseAdvancedMode() &&
      window.isAdvancedMode()
    );
  }

  function backendSetBaseUrl(url) {
    if (!url || typeof url !== 'string') return;
    var clean = url.trim().replace(/\/$/, '');
    window.CURSIA_BACKEND.baseUrl = clean;
    window.CURSIA_BACKEND.status  = 'unknown';
    try { localStorage.setItem('CURSIA_BACKEND_URL', clean); } catch (e) {}
  }

  function enableBackendCloud() {
    try {
      // Quitar el override de desactivación
      localStorage.removeItem('CURSIA_BACKEND_DISABLED');
      // En entornos no-producción: marcar explícitamente como activo
      if (window.location.hostname !== 'cursia.nomaddi.com') {
        localStorage.setItem('CURSIA_BACKEND_ENABLED', 'true');
      }
    } catch (e) {}
    window.CURSIA_BACKEND.enabled = true;
    window.CURSIA_BACKEND.status  = 'unknown';
    _renderBackendPanel();
  }

  function disableBackendCloud() {
    try {
      // En producción: el flag positivo no sirve para desactivar → usar DISABLED
      // (staging: también ON por defecto → mismo override explícito)
      if (window.location.hostname === 'cursia.nomaddi.com' || window.location.hostname === 'staging.orbia.pages.dev') {
        localStorage.setItem('CURSIA_BACKEND_DISABLED', 'true');
      }
      // En cualquier entorno: quitar el flag de activación explícita
      localStorage.removeItem('CURSIA_BACKEND_ENABLED');
    } catch (e) {}
    window.CURSIA_BACKEND.enabled   = false;
    window.CURSIA_BACKEND.status    = 'disabled';
    window.CURSIA_BACKEND.lastError = null;
    _renderBackendPanel();
  }

  // ──────────────────────────────────────────────────────────────
  // API pública — requests
  // ──────────────────────────────────────────────────────────────

  // ── Obtener access_token de Supabase de forma segura ─────────────────────
  // No cachea el token en localStorage — lo lee fresco del cliente Supabase
  // (que ya lo maneja con autoRefresh). No loggea el token.
  function _getSupabaseToken() {
    return new Promise(function (resolve) {
      if (!window.SB) { resolve(null); return; }
      try {
        window.SB.auth.getSession().then(function (res) {
          var token = res && res.data && res.data.session && res.data.session.access_token;
          resolve(token || null);
        }).catch(function () { resolve(null); });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /**
   * Realiza una petición autenticada al backend.
   *
   * @param {string} path        — ruta relativa (ej. '/api/v1/jobs/full')
   * @param {object} [options]   — opciones de fetch (method, body, …)
   * @param {number} [timeoutMs] — timeout en ms (default: 8000).
   *   Usar 30000 para POSTs de creación de jobs que pueden tardar en cold start.
   */
  function backendApiRequest(path, options, timeoutMs) {
    if (!backendIsEnabled()) {
      return Promise.resolve({ ok: false, error: 'Backend desactivado' });
    }
    // Obtener token Supabase antes del fetch
    return _getSupabaseToken().then(function (token) {
      if (!token) {
        // Sin sesión activa → informar sin romper la app
        return { ok: false, error: 'no_session', errorType: 'auth' };
      }
      var url  = _baseUrl() + path;
      var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
      var opts = Object.assign({}, options || {}, { headers: headers });
      if (opts.body && typeof opts.body === 'object') {
        opts.body = JSON.stringify(opts.body);
      }
      return _fetchWithTimeout(url, opts, timeoutMs).then(function (result) {
        if (!result.ok) {
          // #583 (N8): un sondeo silencioso no pinta el estado del backend ni sondea /health.
          if (opts._quiet) return result;
          // Sondear /health para distinguir "red momentánea" de "backend caído"
          return _probeHealthOnFailure(result);
        }
        // Éxito → backend está vivo
        window.CURSIA_BACKEND.status    = 'connected';
        window.CURSIA_BACKEND.lastError = null;
        return result;
      });
    });
  }

  function backendHealthCheck() {
    var url = _baseUrl() + '/health';
    return _fetchWithTimeout(url).then(function (result) {
      if (result.ok) {
        window.CURSIA_BACKEND.status    = 'connected';
        window.CURSIA_BACKEND.lastError = null;
      } else {
        window.CURSIA_BACKEND.status    = 'error';
        window.CURSIA_BACKEND.lastError = result.error;
      }
      return result;
    });
  }

  function backendCreateCourse(course) {
    return backendApiRequest('/api/v1/courses', { method: 'POST', body: course });
  }

  /**
   * Crea una versión de curso en el backend.
   * @param {number} courseId
   * @param {object} payload — puede contener snapshotJson Y/O campos de storage
   *   { snapshotJson?, storageProvider?, storageFileId?, storageFileUrl?,
   *     storageFolderId?, snapshotStrategy?, snapshotSizeBytes?,
   *     snapshotSizeHuman?, manifestJson?, notes? }
   */
  function backendCreateCourseVersion(courseId, payload) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/versions', {
      method: 'POST',
      body: payload
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Fase 2 — Editor de estructura dinámica (staging only)
  // ──────────────────────────────────────────────────────────────

  function backendCreateDynamicCourse(frontendCourseId, title) {
    return backendApiRequest('/api/v1/courses/dynamic', {
      method: 'POST',
      body: { frontendCourseId: frontendCourseId, title: title }
    });
  }

  function backendGetCourseStructure(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules', { method: 'GET' });
  }

  function backendCreateModule(courseId, payload) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules', {
      method: 'POST', body: payload
    });
  }

  function backendUpdateModule(courseId, moduleId, payload) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/' + moduleId, {
      method: 'PATCH', body: payload
    });
  }

  function backendDeleteModule(courseId, moduleId, expectedCounter) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/' + moduleId, {
      method: 'DELETE', body: { expectedCounter: expectedCounter }
    });
  }

  function backendReorderModules(courseId, order, expectedCounter) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/reorder', {
      method: 'PATCH', body: { order: order, expectedCounter: expectedCounter }
    });
  }

  function backendCreateChapter(courseId, moduleId, payload) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/' + moduleId + '/chapters', {
      method: 'POST', body: payload
    });
  }

  function backendUpdateChapter(courseId, moduleId, chapterId, payload) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/' + moduleId + '/chapters/' + chapterId, {
      method: 'PATCH', body: payload
    });
  }

  // V2.1 (R3): toggles de curso del Blueprint v2. payload = { finalExam?, activityEngine?, expectedCounter }.
  function backendUpdateStructureSettings(courseId, payload) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/structure-settings', {
      method: 'PATCH', body: payload
    });
  }

  // V2.1 F1: perfiles de curso (presentation | assessment). GET → vigente o el
  // default (isDefault:true); para presentación, `opts.paletteId` deriva el
  // default de la paleta elegida (nunca persiste). POST agrega una versión.
  function backendGetCourseProfile(courseId, kind, opts) {
    var q = (opts && opts.paletteId) ? '?paletteId=' + encodeURIComponent(opts.paletteId) : '';
    return backendApiRequest('/api/v1/courses/' + courseId + '/profiles/' + encodeURIComponent(kind) + q, { method: 'GET' });
  }

  function backendSaveCourseProfile(courseId, kind, data, expectedVersion) {
    var body = { data: data };
    if (typeof expectedVersion === 'number') body.expectedVersion = expectedVersion;
    return backendApiRequest('/api/v1/courses/' + courseId + '/profiles/' + encodeURIComponent(kind), {
      method: 'POST', body: body
    });
  }

  // ── Motor pedagógico V1 (49-pedagogy-panel.js): lectura + lógica pura, nada se genera ni se cobra ──
  function backendPedagogyCatalog() {
    return backendApiRequest('/api/v1/pedagogy/catalog', { method: 'GET' });
  }

  function backendPedagogyWizard() {
    return backendApiRequest('/api/v1/pedagogy/wizard', { method: 'GET' });
  }

  function backendPedagogyRecommend(answers) {
    return backendApiRequest('/api/v1/pedagogy/recommend', { method: 'POST', body: { answers: answers || {} } });
  }

  // body: { profile? (vista previa sin guardar), activityTypeRules?, applyStructureAdjustments? }
  function backendPedagogyCourseDryRun(courseId, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/pedagogy/dry-run', { method: 'POST', body: body || {} });
  }

  // Fase 3 · Contexto académico (50-academic-context-panel.js): extracción determinista (sin proveedores, sin guardar)
  // y diseño desde el contexto guardado. files = [{ name, dataBase64 }] (1 a 5). Guardar = backendSaveCourseProfile(…, 'academic', …).
  function backendExtractAcademicContext(courseId, files) {
    // Review I6: subir varios MB y leer un PDF largo supera el timeout por defecto (8 s).
    return backendApiRequest('/api/v1/courses/' + courseId + '/academic-context/extract', { method: 'POST', body: { files: files || [] } }, 120000);
  }

  // LOOP 8.2 · «Lo que entendimos»: sin documento, lo que Cursia entendió del pedido (contexto propuesto) y la edición /
  // confirmación de los resultados de aprendizaje. body = { expectedVersion, … } (ver academic-context.controller).
  function backendSaveAcademicProposal(courseId, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/academic-context/proposal', { method: 'POST', body: body || {} });
  }
  function backendSaveAcademicOutcomes(courseId, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/academic-context/outcomes', { method: 'PUT', body: body || {} });
  }

  // LOOP 8.3 · «Cursia recomienda»: diseño recomendado (body { adjust? }, nada se guarda) y «Liberar» lo fijado a mano.
  function backendDesignRecommendation(courseId, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/design/recommendation', { method: 'POST', body: body || {} }, 60000);
  }
  // Review L83 I-3: horas que propuso Cursia y «Usar este diseño» guardó (null = no son de Cursia).
  function backendRecordDesignHours(courseId, proposed) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/design/hours-origin', { method: 'POST', body: { proposed: proposed } });
  }
  // LOOP 8.4 · «Corregir» automático de la verificación (body { action: 'link_outcomes', expectedCounter }).
  function backendDesignFix(courseId, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/design/fix', { method: 'POST', body: body || {} }, 60000);
  }
  // ── Prebrief pedagógico: propuesta versionada, aprobación y PDF (el servidor decide todo; la interfaz muestra) ──
  function backendPrebriefState(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/prebrief', { method: 'GET' }, 60000);
  }
  function backendPrebriefPrepare(courseId, expectedModelSha) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/prebrief/versions', { method: 'POST', body: { expectedModelSha: expectedModelSha } }, 90000);
  }
  function backendPrebriefApprove(courseId, version, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/prebrief/versions/' + version + '/approve', { method: 'POST', body: body }, 90000);
  }
  function backendPrebriefRequestChanges(courseId, version, note) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/prebrief/versions/' + version + '/request-changes', { method: 'POST', body: { note: note } }, 60000);
  }
  function backendPrebriefWithdraw(courseId, version) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/prebrief/versions/' + version + '/withdraw', { method: 'POST', body: {} }, 60000);
  }
  function backendPrebriefExceptionReason(courseId, requirementKey, reason) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/prebrief/exception-reasons', { method: 'PUT', body: { requirementKey: requirementKey, reason: reason } }, 60000);
  }
  function backendPrebriefConfirm(courseId, confirmKey) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/prebrief/confirmations', { method: 'POST', body: { confirmKey: confirmKey } }, 60000);
  }
  // Fase 2 · «¿Cómo quieres estructurar tu curso?»: opciones (lo que encontró Cursia) y vista previa de una forma.
  function backendStructureOptions(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/design/structure-options', { method: 'GET' }, 60000);
  }
  function backendStructurePreview(courseId, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/design/structure-preview', { method: 'POST', body: body }, 60000);
  }
  function backendGetCourseFormat(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/format', { method: 'GET', _quiet: true }, 20000);
  }
  function backendCourseFormat(courseId, code) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/format', { method: 'PUT', body: { code: code } }, 60000);
  }
  /** PDF del Prebrief (borrador o de una versión): { ok, blob, filename } — descarga directa, nunca una impresión de la pantalla. */
  function backendPrebriefPdf(courseId, version, variant) {
    if (!backendIsEnabled()) return Promise.resolve({ ok: false, error: 'Backend desactivado' });
    var path = version ? '/api/v1/courses/' + courseId + '/prebrief/versions/' + version + '/pdf' + (variant ? '?variant=' + encodeURIComponent(variant) : '') : '/api/v1/courses/' + courseId + '/prebrief/draft.pdf';
    return _getSupabaseToken().then(function (token) {
      if (!token) return { ok: false, error: 'no_session', errorType: 'auth' };
      return fetch(_baseUrl() + path, { headers: { 'Authorization': 'Bearer ' + token } }).then(function (res) {
        if (!res.ok) return res.json().catch(function () { return {}; }).then(function (b) { return { ok: false, error: (b && b.error) || ('HTTP ' + res.status), _httpStatus: res.status }; });
        var disp = res.headers.get('content-disposition') || '';
        var m = /filename="([^"]+)"/.exec(disp);
        return res.blob().then(function (blob) { return { ok: true, blob: blob, filename: m ? m[1] : 'Cursia_Prebrief.pdf' }; });
      }).catch(function (err) { return { ok: false, error: err ? (err.message || String(err)) : 'Error de red' }; });
    });
  }
  // LOOP 8.6B · requisitos explícitos del documento (solo lectura) y la alternativa (S/M/L…) que elige el docente.
  function backendGetDocumentRequirements(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/academic-context/requirements', { method: 'GET' });
  }
  function backendSetRequirementSelection(courseId, groupId, optionId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/academic-context/requirements/selection', { method: 'PUT', body: { groupId: groupId, optionId: optionId == null ? null : optionId } });
  }
  // LOOP 8.6C · decisiones del docente que se apartan del documento ({ audiovisual?, applicationActivities? }; null = quitar).
  function backendSaveRequirementDecisions(courseId, decisions) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/design/requirement-decisions', { method: 'POST', body: decisions || {} });
  }
  function backendClearDesignPins(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/design/pins/clear', { method: 'POST', body: {} });
  }

  // Fase 5 · vista previa del impacto de los cambios (sin escrituras ni proveedores): qué se regeneraría, qué queda
  // intacto y cuánto costaría. body = { fromRunId?, profile? (borrador), applyDistribution? }.
  function backendChangeImpact(courseId, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/change-impact', { method: 'POST', body: body || {} }, 30000);
  }

  function backendGetAcademicDesign(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/academic-context/design', { method: 'GET' });
  }

  // Fase 2 · «Aplicar diseño»: la propuesta del distribuidor (huella que vio el docente) pasa a la estructura real.
  function backendApplyDistribution(courseId, payload) {
    // QA Fase 2: aplica el diseño recalculándolo en el servidor (varios segundos en cursos grandes): con el tope de 8 s el
    // navegador daba por fallado un diseño que el servidor sí aplicó.
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/apply-distribution', { method: 'POST', body: payload }, 90000);
  }

  // LOOP 8.0: la estructura del microcurrículo (contexto académico guardado) reemplaza la del curso.
  // payload: { expectedCounter, contextVersion, confirmReplace? }. 409 STRUCTURE_REPLACE_NEEDS_CONFIRMATION si hay trabajo
  // del docente o una versión confirmada y no se confirmó.
  function backendApplyAcademicStructure(courseId, payload) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/apply-academic-structure', { method: 'POST', body: payload }, 90000);
  }

  // LOOP 8.1: pedido del curso (lo que el usuario dijo en Datos) y «Lo que sabemos del curso» (fuente única).
  function backendGetBrief(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/brief', { method: 'GET' });
  }
  function backendPutBrief(courseId, fields) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/brief', { method: 'PUT', body: fields });
  }
  function backendGetFacts(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/facts', { method: 'GET' });
  }
  // LOOP 8.1 (review L81 I1e): «Usar los datos del documento» en el perfil pedagógico (fields opcional).
  function backendUseDocumentInPedagogy(courseId, fields, expectedVersion) {
    var body = fields && fields.length ? { fields: fields } : {};
    if (typeof expectedVersion === 'number') body.expectedVersion = expectedVersion;
    return backendApiRequest('/api/v1/courses/' + courseId + '/profiles/pedagogy/use-document', { method: 'POST', body: body });
  }
  // LOOP 8.1: lectura avanzada de un PDF (mode 'estimate' sin proveedor; 'run' con acceptedMaxUsd). 120 s como /extract.
  function backendExtractAdvanced(courseId, payload) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/academic-context/extract-advanced', { method: 'POST', body: payload }, 120000);
  }

  // LOOP 8.0: registra que la estructura vigente es la propuesta de la IA (payload: { expectedCounter, source: 'ai_proposal' }).
  function backendRecordStructureOrigin(courseId, payload) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/structure-origin', { method: 'POST', body: payload });
  }

  function backendDeleteChapter(courseId, moduleId, chapterId, expectedCounter) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/' + moduleId + '/chapters/' + chapterId, {
      method: 'DELETE', body: { expectedCounter: expectedCounter }
    });
  }

  function backendReorderChapters(courseId, moduleId, order, expectedCounter) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/' + moduleId + '/chapters/reorder', {
      method: 'PATCH', body: { order: order, expectedCounter: expectedCounter }
    });
  }

  function backendMoveChapter(courseId, moduleId, chapterId, targetModuleId, targetPosition, expectedCounter) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/modules/' + moduleId + '/chapters/' + chapterId + '/move', {
      method: 'PATCH', body: { targetModuleId: targetModuleId, targetPosition: targetPosition, expectedCounter: expectedCounter }
    });
  }

  function backendListCourses() {
    return backendApiRequest('/api/v1/courses', { method: 'GET' });
  }

  // Acceptance fix (Important 1): título real de un curso V2 abierto en un
  // navegador sin estado local (GET /courses/:id, ownership en el backend).
  function backendGetCourse(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId, { method: 'GET' });
  }

  function backendListCourseVersions(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/versions', { method: 'GET' });
  }

  // ──────────────────────────────────────────────────────────────
  // Fase 3 — Blueprints (staging only)
  // ──────────────────────────────────────────────────────────────

  function backendCreateBlueprint(courseId, expectedCounter) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints', {
      method: 'POST', body: { expectedCounter: expectedCounter }
    });
  }

  function backendListBlueprints(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints', { method: 'GET' });
  }

  function backendGetCurrentBlueprint(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/current', { method: 'GET' });
  }

  function backendGetBlueprint(courseId, n) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n, { method: 'GET' });
  }

  /**
   * Fase 5A Task 6b — additive hook: la UI mínima de generación (43) necesita
   * saber si el Blueprint vigente ya tiene un Generation Manifest (Fase 4) y
   * sus totales por tipo para el resumen de "Generar (staging)". No existía
   * ningún wrapper para GET .../manifest — 404 si no se creó todavía (esta
   * función nunca lo crea, solo lo lee; crearlo es un paso explícito
   * separado, fuera de esta pantalla).
   */
  function backendGetManifest(courseId, n) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest', { method: 'GET' });
  }

  /**
   * Fase 5C — additive hook: get-or-create idempotente del Generation
   * Manifest de un Blueprint (POST existente del backend, sin body; 201 si
   * se creó, 200 si ya existía; responde {created, manifest}). No crea
   * production_jobs ni tiene costo. 43 lo llama SOLO cuando el usuario
   * confirma «Generar curso» (fix wave 5C, I2) — nunca al abrir la pantalla.
   */
  function backendCreateManifest(courseId, n) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest', { method: 'POST' });
  }

  /**
   * Fix wave 5C (I1) — additive hook: permisos del usuario resueltos por el
   * SERVIDOR. GET /api/v1/features → { dynamicCourseStructure, realVideo }.
   * 43 muestra/permite el modo de video real solo si realVideo === true; si
   * el endpoint todavía no existe (404) cae al chequeo visual anterior y
   * nunca envía videoMode 'real'.
   */
  function backendGetFeatures() {
    return backendApiRequest('/api/v1/features', { method: 'GET' });
  }

  // ──────────────────────────────────────────────────────────────
  // Fase 5A Task 6a — Generación dynamic: runs (get-or-create/estado/
  // cancelar/reintentar) + ejecutor del navegador (claim/heartbeat/
  // complete/fail). Puramente aditivo — 45-dynamic-generation-executor.js
  // es el único caller. Mismo helper autenticado (backendApiRequest) y
  // mismo estilo de error que el resto del archivo.
  // ──────────────────────────────────────────────────────────────

  /**
   * Get-or-create de un run para el Manifest vigente de un Blueprint.
   * @param {number} courseId    — id numérico del curso en el backend
   * @param {number} n           — número de Blueprint
   * @param {object} body        — CourseContext (+ opcional scormTemplateIds/videoMode)
   */
  function backendDynStartRun(courseId, n, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs', {
      method: 'POST', body: body
    }, 30000);
  }

  // REL lease de ejecución: id del ejecutor del navegador ESTABLE POR EQUIPO (localStorage). Una recarga o
  // una segunda pestaña de este equipo continúan el lease del run al instante (Web Locks sigue ordenando las
  // pestañas); otro equipo espera a que venza. Sin localStorage (modo privado) → uno por carga de página.
  var DYN_DEVICE_EXECUTOR_KEY = 'cursia:dynExecutorDeviceId';
  var _dynDeviceExecutorIdMem = null;
  function backendDynDeviceExecutorId() {
    var id = null;
    try { id = window.localStorage.getItem(DYN_DEVICE_EXECUTOR_KEY); } catch (e) { id = null; }
    if (typeof id === 'string' && /^browser-dev-[a-z0-9]{8,64}$/.test(id)) return id;
    if (_dynDeviceExecutorIdMem) return _dynDeviceExecutorIdMem;
    var rnd = '';
    try {
      var buf = new Uint8Array(12);
      window.crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length; i++) rnd += ('0' + buf[i].toString(16)).slice(-2);
    } catch (e2) {
      rnd = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    }
    id = 'browser-dev-' + rnd.toLowerCase().replace(/[^a-z0-9]/g, '');
    _dynDeviceExecutorIdMem = id;
    try { window.localStorage.setItem(DYN_DEVICE_EXECUTOR_KEY, id); } catch (e3) { /* solo en memoria */ }
    return id;
  }
  // Las lecturas del run llevan el executorId del equipo solo para `executionLease.heldByYou` (nunca
  // condiciona el acceso al curso ni al run).
  function _dynRunReadQuery() {
    try { return '?executorId=' + encodeURIComponent(backendDynDeviceExecutorId()); } catch (e) { return ''; }
  }

  function backendDynGetCurrentRun(courseId, n) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs' + _dynRunReadQuery(), { method: 'GET' });
  }

  /**
   * Flujo normal: estimado COMPLETO + decisión de presupuesto + si el usuario
   * puede aprobar (solo lectura). body = el mismo CourseContext que se enviaría
   * a backendDynStartRun.
   */
  function backendDynPreviewStart(courseId, n, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/estimate-preview', {
      method: 'POST', body: body
    }, 30000);
  }

  /** «Autorizar y generar»: CourseContext + estimateHash del estimado que se mostró. */
  function backendDynApproveAndStart(courseId, n, body, estimateHash) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/approve-and-start', {
      method: 'POST', body: Object.assign({}, body, { estimateHash: estimateHash })
    }, 30000);
  }

  function backendDynEstimate(courseId, n) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/estimate', { method: 'GET' });
  }

  // #583 (N8): opts.quiet (sondeo del panel / vigía): un fallo transitorio (503, red) se registra sin
  // console.warn ni sondeo de /health — el llamador ya reintenta con espera creciente.
  function backendDynGetRun(courseId, n, runId, opts) {
    var o = { method: 'GET' };
    if (opts && opts.quiet) o._quiet = true;
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + _dynRunReadQuery(), o);
  }

  function backendDynCancelRun(courseId, n, runId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/cancel', { method: 'POST' });
  }

  /** Pausa REAL en el servidor: el run no recibe partes nuevas hasta backendDynResumeRun (acción explícita). */
  function backendDynPauseRun(courseId, n, runId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/pause', { method: 'POST' });
  }
  function backendDynResumeRun(courseId, n, runId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/resume', { method: 'POST' });
  }

  // I4 (final review): `resubmitVideo` es opcional — solo la UI de "Reintentar
  // con nuevo video" lo manda como `true`; el retry normal sigue sin body
  // (backend RetryItemDto trata resubmitVideo ausente como false).
  // resubmitVideo / resubmitProvider (excluyentes): reenvío EXPLÍCITO de una operación pagada cuyo
  // intento anterior quedó ambiguo — el backend lo reconoce (su reserva queda contada) y pide uno nuevo.
  function backendDynRetryItem(courseId, n, runId, itemKey, resubmitVideo, resubmitProvider) {
    var body = resubmitVideo ? { resubmitVideo: true } : (resubmitProvider ? { resubmitProvider: true } : {});
    return backendApiRequest(
      '/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/items/' + encodeURIComponent(itemKey) + '/retry',
      { method: 'POST', body: body }, 30000
    );
  }

  /**
   * @param {string[]} types — subconjunto de ['content','scorm','exam'] (rulesVersion 1) o, con un
   *   Manifest rulesVersion 2 (R2), además 'course_plan','course_intro','module_intro'.
   *   (video: solo el worker del backend).
   */
  // Motor pedagógico Fase 2: el ejecutor declara que aplica el brief pedagógico del claim (dynPedagogyBlock).
  // Por query: el body es whitelist estricta y CORS no admite headers propios; un backend anterior lo ignora.
  // El backend rechaza (409 visible, «recarga la página») un run con diseño reclamado sin esta capacidad.
  // Fase 2: 'application-activity-1' = sabe generar items application_activity (sin ella, un run con Actividades
  // de Aplicación responde el mismo 409 visible: una pestaña vieja nunca lo deja a medias en silencio).
  var DYN_EXECUTOR_FEATURES = 'pedagogy-brief-1,application-activity-1';
  function backendDynClaim(runId, executorId, types, leaseSeconds) {
    return backendApiRequest('/api/v1/dynamic-generation/claim?features=' + DYN_EXECUTOR_FEATURES, {
      method: 'POST',
      body: { runId: runId, executorId: executorId, types: types, leaseSeconds: leaseSeconds }
    });
  }

  // REL lease: el titular suelta el lease de ejecución del run (al cerrar la página: best-effort, keepalive;
  // el vencimiento del lease es la garantía).
  function backendDynReleaseLease(runId, executorId, opts) {
    var o = { method: 'POST', body: { executorId: executorId }, _quiet: true };
    if (opts && opts.keepalive) o.keepalive = true;
    return backendApiRequest('/api/v1/dynamic-generation/runs/' + runId + '/release-lease', o, 5000);
  }

  function backendDynHeartbeat(itemRunId, executorId, leaseSeconds) {
    return backendApiRequest('/api/v1/dynamic-generation/items/' + itemRunId + '/heartbeat', {
      method: 'POST',
      body: { executorId: executorId, leaseSeconds: leaseSeconds }
    });
  }

  function backendDynComplete(itemRunId, executorId, artifactIds, summary) {
    return backendApiRequest('/api/v1/dynamic-generation/items/' + itemRunId + '/complete', {
      method: 'POST',
      body: { executorId: executorId, artifactIds: artifactIds, summary: summary || {} }
    });
  }

  // M1 (final review): FailItemDto.error tiene @MaxLength(4000) en el
  // backend — un error largo (proxy/LLM) sin truncar acá vuelve 400, y el
  // fail nunca se registra: el item espera su lease y lo barre el sweep como
  // 'lease_expired' (retryable), convirtiendo un error PERMANENTE en un
  // reintento silencioso. Truncar a 3900 (margen bajo 4000) deja el fail
  // siempre pasar.
  var DYN_FAIL_ERROR_MAX_LEN = 3900;
  // extra (opcional, BANKOPT): { examBankDraftArtifactId } — borrador del banco de un examen incompleto.
  // Solo se manda si el claim anunció soporte (FailItemDto con whitelist estricta en el backend).
  function backendDynFail(itemRunId, executorId, error, retryable, extra) {
    var msg = String(error == null ? '' : error);
    if (msg.length > DYN_FAIL_ERROR_MAX_LEN) msg = msg.slice(0, DYN_FAIL_ERROR_MAX_LEN);
    var body = { executorId: executorId, error: msg, retryable: !!retryable };
    if (extra && typeof extra.examBankDraftArtifactId === 'string' && extra.examBankDraftArtifactId) body.examBankDraftArtifactId = extra.examBankDraftArtifactId;
    // Fix round 4 (R4): null explícito = borrar el borrador anterior (falla de reglas sin faltante).
    else if (extra && extra.examBankDraftArtifactId === null) body.examBankDraftArtifactId = null;
    return backendApiRequest('/api/v1/dynamic-generation/items/' + itemRunId + '/fail', {
      method: 'POST',
      body: body
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Fase 5B.1 — Empaquetado Moodle dinámico (staging). Puramente aditivo —
  // 43-dynamic-structure-editor.js es el único caller. El backend crea/reusa
  // un job dynamic_package (202 con {jobId,status}) y expone su estado con
  // {status, artifactId?, downloadUrl?, error?}; ver packaging.controller.ts.
  // ──────────────────────────────────────────────────────────────

  function backendDynPackage(courseId, n, runId) {
    return backendApiRequest(
      '/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/package',
      { method: 'POST' }
    );
  }

  /**
   * EV6 DoD fix round 2 (BE-B): cola de recuperación de admin (SUPER_ADMIN, solo lectura).
   * GET /api/v1/admin/dynamic-runs/needs-attention?limit=N → { generatedAt, scanned,
   * needsAttention[], legacyPreview[], errors[] }.
   */
  // #542 (G6): POST /api/v1/admin/dynamic-runs/:runId/videogen-reservations/reconcile (solo SUPER_ADMIN).
  // body {reservationKey, outcome: 'not_charged' | 'charged', reason}. Decisión explícita; nunca automática.
  function backendDynReconcileVideogenReservation(runId, body) {
    return backendApiRequest('/api/v1/admin/dynamic-runs/' + encodeURIComponent(runId) + '/videogen-reservations/reconcile', { method: 'POST', body: body }, 30000);
  }

  function backendDynAdminNeedsAttention(limit) {
    var n = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
    return backendApiRequest('/api/v1/admin/dynamic-runs/needs-attention?limit=' + n, { method: 'GET' });
  }

  function backendDynGetPackage(courseId, n, runId) {
    return backendApiRequest(
      '/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/package',
      { method: 'GET' }
    );
  }

  // ──────────────────────────────────────────────────────────────
  // DN-1 (entrega de video por YouTube) — puramente aditivo. 43 es el único
  // caller. El preflight es de SOLO LECTURA (no sube nada, no gasta) y
  // nunca devuelve tokens: {ok, channel:{id,title,thumbnail}|null,
  // checks:[{key,ok}], reason?}. La conexión OAuth reutiliza los endpoints
  // legacy existentes (los mismos que usa 25-youtube.js): POST
  // /youtube/oauth/session → {oauthUrl} y GET /youtube/connection.
  // ──────────────────────────────────────────────────────────────

  function backendDynYoutubePreflight() {
    return backendApiRequest('/api/v1/dynamic/youtube/preflight', { method: 'GET' }, 20000);
  }

  function backendYoutubeOAuthSession() {
    return backendApiRequest('/api/v1/youtube/oauth/session', { method: 'POST' }, 15000);
  }

  function backendYoutubeConnection() {
    return backendApiRequest('/api/v1/youtube/connection', { method: 'GET' });
  }

  // DN-1 BE: resolución EXPLÍCITA de una publicación ambigua de un video ya
  // generado. body = {action:'confirm_existing', youtubeVideoId:'<11>'} |
  // {action:'authorize_reupload'} (UNA re-subida; nunca una generación nueva).
  // → 200 item en 'pending'; 400 id/cuerpo inválido; 409 not_ambiguous |
  // not_youtube_run.
  function backendDynYoutubeResolution(courseId, n, runId, itemKey, body) {
    return backendApiRequest(
      '/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/items/' + encodeURIComponent(itemKey) + '/youtube-resolution',
      { method: 'POST', body: body }
    );
  }

  // ──────────────────────────────────────────────────────────────
  // Fase 7/8 (F78-FE) — Coherence Engine e invalidación. Puramente aditivo —
  // 43-dynamic-structure-editor.js es el único caller y aísla el parseo de
  // cada respuesta en un adapter propio (dynCohParse*/dynInvParsePlan).
  // Todas estas rutas son dynamic (404 con el flag del servidor apagado).
  // ──────────────────────────────────────────────────────────────

  // Capa estructural (S1–S3) sobre la estructura VIVA (sin body) — no persiste.
  // → { source, blueprintNumber, ruleset, reportSha256, blueprintSha256, findings[] }
  function backendCoherenceStructure(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/coherence/structure', { method: 'POST', body: {} }, 20000);
  }

  // Último reporte de coherencia de contenido del run (404 si todavía no hay).
  // → { created:false, artifactId, source, report }
  function backendCoherenceGetRunReport(courseId, n, runId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/coherence', { method: 'GET' });
  }

  // Calcula (idempotente por hash) y guarda el reporte de contenido del run.
  function backendCoherenceComputeRunReport(courseId, n, runId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/coherence', { method: 'POST' }, 30000);
  }

  // Sube los findings de la revisión con IA (corrió en el navegador).
  // body = { model, promptSha256 (64 hex), findings[] } → reporte fusionado.
  function backendCoherenceUploadLlmFindings(courseId, n, runId, body) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/coherence/llm-findings', {
      method: 'POST', body: body
    }, 30000);
  }

  // Plan de invalidación (dry-run, sin escrituras) del Blueprint n desde el
  // run de origen. El apply es backendDynStartRun(courseId, n, {fromRun}).
  function backendDynInvalidationPlan(courseId, n, fromRunId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/invalidation-plan?fromRun=' + encodeURIComponent(fromRunId), { method: 'GET' });
  }

  // F78-BE2: regenera un item como generación NUEVA (la anterior queda
  // intacta). confirmPaid → {confirmPaid:true} (booleano literal, exigido si
  // tiene costo: video en run real o cualquier item LLM). Fix wave (I2):
  // expectedGeneration (número, la `currentGeneration` del dry-run) → el
  // backend responde 409 {code:'generation_changed', currentGeneration} si la
  // parte ya se regeneró en otra pestaña (sin escribir nada).
  // → 201 {created:true, costKind, previousItemRunId, previousGeneration, item, run, affected[]}
  //   200 {created:false, …} si ya estaba en vuelo (mismo item).
  function backendDynRegenerateItem(courseId, n, runId, itemKey, confirmPaid, expectedGeneration) {
    var body = {};
    if (confirmPaid) body.confirmPaid = true;
    if (typeof expectedGeneration === 'number') body.expectedGeneration = expectedGeneration;
    return backendApiRequest(
      '/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/items/' + encodeURIComponent(itemKey) + '/regenerate',
      { method: 'POST', body: body }
    );
  }

  // Fix wave (I1): dry-run de la regeneración (sin escrituras).
  // → 200 {dryRun:true, affected[], blockers:[{code,message}], costKind, currentGeneration}
  function backendDynRegenerateDryRun(courseId, n, runId, itemKey) {
    return backendApiRequest(
      '/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/items/' + encodeURIComponent(itemKey) + '/regenerate',
      { method: 'POST', body: { dryRun: true } }
    );
  }

  // EV6 T5 B2: «Generar videos reales» — vista previa SOLO lectura (videos pendientes del run,
  // estimado USD, aprobación, trabas, estimateHash) y confirmación con la huella vista.
  // Confirmación: 201 upgrade creado · 200 ya existía (idempotente, nunca un segundo pago).
  function backendDynVideoUpgradePreview(courseId, n, runId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/video-upgrade/preview', { method: 'POST' });
  }
  function backendDynVideoUpgrade(courseId, n, runId, estimateHash) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/video-upgrade', { method: 'POST', body: { estimateHash: estimateHash } });
  }

  // F78-BE2: entrada compacta y acotada para la revisión con IA (outline +
  // resúmenes planeados y reales). 403 sin coherenceLlm, 409 run no completo,
  // 422 no entra en el tope.
  function backendCoherenceGetLlmInput(courseId, n, runId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/blueprints/' + n + '/manifest/runs/' + runId + '/coherence/llm-input', { method: 'GET' });
  }

  /**
   * Sube un artifact dynamic con un `courseId` EXPLÍCITO (R4: el
   * ClaimedItem.artifactCourseId del claim — el frontend course id
   * congelado en el run, o el id numérico como texto si no hay uno) — a
   * diferencia de artifactUpload() (arriba), que siempre usa
   * window.ACTIVE_COURSE_ID. Función nueva y separada a propósito: no se
   * toca artifactUpload() (aditivo, ver CLAUDE.md — nunca se modifican
   * funciones existentes de este archivo).
   */
  function dynArtifactUpload(courseId, type, content, filename, mimeType, metadata, options) {
    if (!window.SB || !window.SB_USER) {
      return Promise.resolve({ ok: false, error: 'no_auth' });
    }
    if (!backendIsEnabled()) {
      return Promise.resolve({ ok: false, error: 'backend_off' });
    }
    options = options || {};
    var userId = window.SB_USER.id;
    var ts = Date.now();
    var safeName = (filename || (type + '_' + ts)).replace(/[^a-zA-Z0-9._-]/g, '_');
    var bucket = options.storageBucket || 'cursia-artifacts';
    var provider = options.storageProvider || 'supabase';
    var folder = String(options.storageFolder || type).replace(/^\/+|\/+$/g, '') || type;
    var storagePath = options.storagePath
      ? String(options.storagePath).replace(/^\/+/, '')
      : (userId + '/' + courseId + '/' + folder + '/' + safeName);

    var blob;
    var detectedMime = mimeType;
    if (content instanceof Blob) {
      blob = content;
      if (!detectedMime) detectedMime = content.type || 'application/octet-stream';
    } else if (typeof content === 'string') {
      blob = new Blob([content], { type: 'text/plain' });
      if (!detectedMime) detectedMime = 'text/plain';
    } else if (content && typeof content === 'object') {
      blob = new Blob([JSON.stringify(content)], { type: 'application/json' });
      if (!detectedMime) detectedMime = 'application/json';
    } else {
      return Promise.resolve({ ok: false, error: 'invalid_content' });
    }

    return window.SB.storage
      .from(bucket)
      .upload(storagePath, blob, { upsert: options.upsert === false ? false : true, contentType: detectedMime })
      .then(function (uploadRes) {
        if (uploadRes.error) {
          console.warn('[Cursia:dyn-artifacts] Storage upload failed:', uploadRes.error.message);
          return { ok: false, error: 'storage_upload_failed: ' + uploadRes.error.message };
        }
        return artifactCreate({
          course_id:    String(courseId),
          job_id:       null,
          type:         type,
          storage_provider: provider,
          storage_bucket: bucket,
          storage_path: storagePath,
          filename:     filename || safeName,
          mime_type:    detectedMime,
          size_bytes:   blob.size || 0,
          checksum_sha256: options.checksumSha256 || null,
          metadata:     metadata || {}
        }).then(function (regRes) {
          var artifactId = (regRes.ok && regRes.data && regRes.data.id) ? regRes.data.id : null;
          if (!artifactId) return { ok: false, error: 'artifact_create_failed' + (regRes.error ? ': ' + String(regRes.error).slice(0, 200) : '') };
          return { ok: true, artifactId: artifactId, storagePath: storagePath, bucket: bucket };
        });
      })
      .catch(function (e) {
        console.warn('[Cursia:dyn-artifacts] Upload error:', e.message || e);
        return { ok: false, error: e.message || 'upload_error' };
      });
  }

  // ──────────────────────────────────────────────────────────────
  // FASE 4.2 — LISTAR CURSOS DESDE NUBE
  // ──────────────────────────────────────────────────────────────

  /** Estado visual mínimo de la lista de cursos (solo en memoria, no en localStorage) */
  var _cloudCoursesState = {
    courses:          null,   // null = no cargado | [] = vacío | [...] = datos
    loading:          false,
    error:            null,
    lastRefresh:      null,   // Date
    expandedCourseId: null,   // id del curso con versiones desplegadas
    versions:         {}      // { courseId: { loading, error, data[] } }
  };

  /**
   * Formatea una fecha ISO a texto legible en español.
   * Ejemplo: "14 may 2026 · 18:33"
   */
  function backendFormatDate(isoString) {
    if (!isoString) return '—';
    try {
      var d = new Date(isoString);
      var day  = d.getDate();
      var mons = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
      var mon  = mons[d.getMonth()];
      var yr   = d.getFullYear();
      var hh   = String(d.getHours()).padStart(2,'0');
      var mm   = String(d.getMinutes()).padStart(2,'0');
      return day + ' ' + mon + ' ' + yr + ' · ' + hh + ':' + mm;
    } catch(e) {
      return isoString.slice(0,16).replace('T',' ');
    }
  }

  /**
   * Genera el HTML de una card de curso.
   * NO incluye botón "Abrir" — solo "Ver versiones".
   */
  function backendRenderCourseCard(course) {
    var id           = course.id;
    var title        = _esc(course.title || 'Sin título');
    var sector       = _esc(course.sector || '—');
    var level        = _esc(course.level  || '—');
    var status       = _esc(course.status || '—');
    var createdAt    = backendFormatDate(course.createdAt  || course.created_at);
    var updatedAt    = backendFormatDate(course.updatedAt  || course.updated_at);
    var isExpanded   = (_cloudCoursesState.expandedCourseId === id);
    var vState       = _cloudCoursesState.versions[id] || {};

    var statusColors = { draft:'#9ca3af', in_review:'#f59e0b', published:'#22c55e', archived:'#6b7280' };
    var sc = statusColors[course.status] || '#9ca3af';

    var html = [
      '<div id="cloud-course-' + id + '" style="border:1px solid rgba(255,255,255,.07);',
        'border-radius:9px;padding:11px 13px;margin-bottom:8px;',
        'background:rgba(255,255,255,.03);">',

        // ── Fila principal ──────────────────────────────────────
        '<div style="display:flex;align-items:flex-start;gap:10px;">',
          '<div style="flex:1;min-width:0;">',
            '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:4px;">',
              '<span style="font-size:13px;font-weight:700;color:rgba(3, 10, 38,.9);">', title, '</span>',
              '<span style="font-size:10px;padding:2px 7px;border-radius:20px;',
                'background:', sc, '22;border:1px solid ', sc, '44;color:', sc, ';font-weight:600;">',
                status,
              '</span>',
            '</div>',
            '<div style="display:flex;flex-wrap:wrap;gap:10px;">',
              '<span style="font-size:11px;color:rgba(3, 10, 38,.45);">',
                '<span style="color:rgba(3, 10, 38,.3);">ID</span> #', String(id),
              '</span>',
              sector !== '—' ? '<span style="font-size:11px;color:rgba(3, 10, 38,.45);"><span style="color:rgba(3, 10, 38,.3);">Sector</span> ' + sector + '</span>' : '',
              level !== '—' ? '<span style="font-size:11px;color:rgba(3, 10, 38,.45);"><span style="color:rgba(3, 10, 38,.3);">Nivel</span> ' + level + '</span>' : '',
            '</div>',
            '<div style="margin-top:4px;font-size:10.5px;color:rgba(3, 10, 38,.3);">',
              'Creado ', createdAt, ' · Actualizado ', updatedAt,
            '</div>',
          '</div>',
          '<button onclick="backendToggleCourseVersions(' + id + ')"',
            ' style="flex-shrink:0;padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.12);',
            'background:rgba(255,255,255,.05);color:rgba(3, 10, 38,.7);font-size:11px;',
            'cursor:pointer;white-space:nowrap;">',
            isExpanded ? '▲ Ocultar' : '▼ Ver versiones',
          '</button>',
        '</div>',

        // ── Bloque de versiones (si expandido) ──────────────────
        isExpanded ? _renderCourseVersionsBlock(id, vState) : '',

      '</div>'
    ];

    return html.join('');
  }

  /**
   * Genera HTML del bloque de versiones para un curso.
   * Solo lectura — sin botones de restaurar/abrir.
   */
  function _renderCourseVersionsBlock(courseId, vState) {
    var html = ['<div style="margin-top:10px;border-top:1px solid rgba(255,255,255,.06);padding-top:10px;">'];

    if (vState.loading) {
      html.push('<div style="font-size:11.5px;color:rgba(3, 10, 38,.45);">⏳ Cargando versiones…</div>');
    } else if (vState.error) {
      html.push('<div style="font-size:11.5px;color:#ef4444;">❌ ' + _esc(vState.error) + '</div>');
    } else if (!vState.data || vState.data.length === 0) {
      html.push('<div style="font-size:11.5px;color:rgba(3, 10, 38,.35);">Sin versiones guardadas.</div>');
    } else {
      html.push(
        '<div style="font-size:10.5px;font-weight:700;letter-spacing:.05em;',
          'color:rgba(3, 10, 38,.35);margin-bottom:6px;">',
          vState.data.length + (vState.data.length !== 1 ? ' VERSIONES' : ' VERSIÓN'),
        '</div>'
      );

      vState.data.forEach(function(v) {
        // Leer tamaño y conteos desde los campos dedicados (Fase 5) o desde snapshotJson.metadata (legacy)
        var legacyMeta = (v.snapshotJson && v.snapshotJson.metadata) || {};
        var manifest   = v.manifestJson || {};
        var counts     = manifest.counts || {};

        var sizeHuman  = v.snapshotSizeHuman
                         || legacyMeta.snapshot_size_human
                         || '—';
        var fKeys      = counts.f_keys       != null ? counts.f_keys       + ' arch.'  :
                         legacyMeta.f_keys_count != null ? legacyMeta.f_keys_count + ' arch.' : '';
        var videos     = counts.media_videos != null ? counts.media_videos + ' videos' :
                         legacyMeta.media_videos_count != null ? legacyMeta.media_videos_count + ' videos' : '';
        var audios     = (counts.media_audio  || legacyMeta.media_audio_count || 0) > 0
                         ? (counts.media_audio || legacyMeta.media_audio_count) + ' audios' : '';
        var savedAt    = backendFormatDate(v.createdAt || v.created_at);

        // Provider badge
        var provider  = v.storageProvider || 'postgres_json';
        var provBadge = '';
        if (provider === 'google_drive') {
          provBadge = '<span style="font-size:10px;padding:1px 6px;border-radius:4px;' +
            'background:rgba(66,133,244,.12);color:#4285f4;font-weight:600;">Drive</span>';
        } else if (provider === 'postgres_json') {
          provBadge = '<span style="font-size:10px;padding:1px 6px;border-radius:4px;' +
            'background:rgba(34,197,94,.1);color:#22c55e;font-weight:600;">PG</span>';
        }

        // Botón "Abrir Drive" si hay URL
        var driveBtn = '';
        var fileUrl  = v.storageFileUrl || (manifest.storage && manifest.storage.file_url) || null;
        if (fileUrl) {
          driveBtn = '<a href="' + _esc(fileUrl) + '" target="_blank" rel="noopener"' +
            ' style="font-size:10.5px;padding:2px 8px;border-radius:5px;' +
            'border:1px solid rgba(66,133,244,.3);background:rgba(66,133,244,.07);' +
            'color:#4285f4;text-decoration:none;white-space:nowrap;">↗ Drive</a>';
        }

        var pills = [sizeHuman, fKeys, videos, audios].filter(Boolean);

        // Botón "Restaurar"
        var vId         = v.id || v.version_id || '';
        var restoreBtn  = vId
          ? '<button onclick="backendRestoreCourseVersion(' + courseId + ',' + vId + ')"' +
              ' title="Restaurar esta versión en la sesión actual"' +
              ' style="font-size:10.5px;padding:2px 8px;border-radius:5px;' +
              'border:1px solid rgba(34,197,94,.35);background:rgba(34,197,94,.07);' +
              'color:#22c55e;cursor:pointer;white-space:nowrap;">↩ Restaurar</button>'
          : '';

        html.push(
          '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;',
            'border-bottom:1px solid rgba(255,255,255,.04);flex-wrap:wrap;">',
            '<span style="font-size:12px;font-weight:700;color:#22c55e;min-width:28px;">v', String(v.versionNumber), '</span>',
            '<span style="font-size:11px;color:rgba(3, 10, 38,.45);">', savedAt, '</span>',
            provBadge,
            pills.map(function(p) {
              return '<span style="font-size:10.5px;padding:1px 6px;border-radius:4px;' +
                'background:rgba(255,255,255,.06);color:rgba(3, 10, 38,.5);">' + _esc(p) + '</span>';
            }).join(''),
            driveBtn,
            restoreBtn,
          '</div>'
        );
      });
    }

    html.push('</div>');
    return html.join('');
  }

  /**
   * Actualiza solo el contenedor #cloud-courses-list del panel, sin re-renderizar todo.
   */
  function _renderCloudCoursesList() {
    var container = document.getElementById('cloud-courses-list');
    if (!container) return;

    var s    = _cloudCoursesState;
    var html = [];

    if (!backendIsEnabled()) {
      html.push(
        '<div style="font-size:12px;color:rgba(3, 10, 38,.4);padding:8px 0;">',
          '☁️ Activa la nube para revisar cursos guardados durante pruebas internas.',
        '</div>'
      );
      container.innerHTML = html.join('');
      return;
    }

    // Sin sesión Supabase — no llamar al backend
    if (!window.SB_USER) {
      html.push(
        '<div style="font-size:12px;color:rgba(3, 10, 38,.45);padding:8px 0;line-height:1.6;">',
          '🔐 <strong style="color:rgba(3, 10, 38,.7);">Inicia sesión</strong> para revisar y restaurar cursos guardados en la nube.',
        '</div>'
      );
      container.innerHTML = html.join('');
      return;
    }

    // Barra superior: título + botón refresh
    html.push(
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">',
        '<span style="font-size:10.5px;font-weight:700;letter-spacing:.05em;color:rgba(3, 10, 38,.4);">',
          'CURSOS GUARDADOS EN NUBE',
        '</span>',
        '<button onclick="backendRefreshCloudCourses()"',
          ' style="font-size:11px;padding:3px 9px;border-radius:6px;',
          'border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);',
          'color:rgba(3, 10, 38,.6);cursor:pointer;">',
          s.loading ? '⏳ Cargando…' : '↻ Actualizar lista',
        '</button>',
      '</div>'
    );

    // Estado
    if (s.loading) {
      html.push('<div style="font-size:12px;color:rgba(3, 10, 38,.45);">⏳ Cargando cursos…</div>');
    } else if (s.error) {
      html.push(
        '<div style="font-size:12px;color:#ef4444;padding:6px 0;">',
          '❌ No se pudo cargar la lista. Cursia sigue funcionando en modo local.',
        '</div>'
      );
    } else if (s.courses === null) {
      html.push(
        '<div style="font-size:12px;color:rgba(3, 10, 38,.35);padding:6px 0;">',
          'Haz clic en "Actualizar lista" para revisar los cursos guardados.',
        '</div>'
      );
    } else if (s.courses.length === 0) {
      html.push(
        '<div style="font-size:12px;color:rgba(3, 10, 38,.35);padding:6px 0;">',
          'No hay cursos guardados en la nube todavía.',
        '</div>'
      );
    } else {
      s.courses.forEach(function(course) {
        html.push(backendRenderCourseCard(course));
      });
      if (s.lastRefresh) {
        html.push(
          '<div style="font-size:10.5px;color:rgba(3, 10, 38,.25);margin-top:6px;">',
            'Actualizado ', backendFormatDate(s.lastRefresh.toISOString()),
          '</div>'
        );
      }
    }

    container.innerHTML = html.join('');
  }

  /**
   * Carga la lista de cursos del backend y actualiza la UI.
   */
  function backendRefreshCloudCourses() {
    if (!backendIsEnabled()) {
      _renderCloudCoursesList();
      return;
    }
    if (!window.SB_USER) {
      _renderCloudCoursesList();
      return;
    }

    _cloudCoursesState.loading = true;
    _cloudCoursesState.error   = null;
    _renderCloudCoursesList();

    backendListCourses().then(function(res) {
      _cloudCoursesState.loading = false;
      if (!res.ok) {
        _cloudCoursesState.error   = res.error || 'Error desconocido';
        _cloudCoursesState.courses = null;
      } else {
        _cloudCoursesState.courses     = Array.isArray(res.data) ? res.data : [];
        _cloudCoursesState.lastRefresh = new Date();
      }
      _renderCloudCoursesList();
    });
  }

  /**
   * Despliega/colapsa versiones de un curso.
   * Si no están cargadas, las solicita al backend.
   */
  function backendToggleCourseVersions(courseId) {
    var wasExpanded = (_cloudCoursesState.expandedCourseId === courseId);
    _cloudCoursesState.expandedCourseId = wasExpanded ? null : courseId;

    if (!wasExpanded) {
      var vState = _cloudCoursesState.versions[courseId];

      // Si ya tenemos datos, solo re-renderizar
      if (vState && vState.data) {
        _renderCloudCoursesList();
        return;
      }

      // Inicializar estado de carga
      _cloudCoursesState.versions[courseId] = { loading: true, error: null, data: null };
      _renderCloudCoursesList();

      backendListCourseVersions(courseId).then(function(res) {
        if (!res.ok) {
          _cloudCoursesState.versions[courseId] = {
            loading: false, error: res.error || 'Error al cargar versiones', data: null
          };
        } else {
          _cloudCoursesState.versions[courseId] = {
            loading: false, error: null,
            data: Array.isArray(res.data) ? res.data : []
          };
        }
        _renderCloudCoursesList();
      });
    } else {
      _renderCloudCoursesList();
    }
  }

  // ──────────────────────────────────────────────────────────────
  // GUARDAR COPIA EN NUBE — refactorizado (Fase 4.1)
  // ──────────────────────────────────────────────────────────────

  // Umbrales de tamaño (bytes)
  var _SIZE_DRIVE_THRESHOLD = 2  * 1048576;   //  2 MB → usar Drive en lugar de PostgreSQL
  var _SIZE_WARN_MB         = 5  * 1048576;   //  5 MB → pedir confirmación (postgres_json path)
  var _SIZE_BLOCK_MB        = 25 * 1048576;   // 25 MB → bloquear si Drive no conectado

  /**
   * Construye el manifest_json que se guarda junto a la versión en el backend.
   * Resume el contenido del curso sin incluir los datos binarios.
   */
  function _buildManifest(cleanSnap, storageInfo) {
    var D_snap  = cleanSnap.D            || {};
    var F_snap  = cleanSnap.F            || {};
    var M_snap  = cleanSnap.MEDIA        || {};
    var VE_snap = cleanSnap.VIDEO_ENGINE || {};

    var fKeys      = Object.keys(F_snap).length;
    var videos     = M_snap.videos ? Object.keys(M_snap.videos).length : 0;
    var audioCount = 0;
    try {
      if (M_snap.transcripts) {
        audioCount = Object.keys(M_snap.transcripts).length;
      }
    } catch(e) {}

    return {
      contains: {
        D:            Object.keys(D_snap).length  > 0,
        F:            fKeys  > 0,
        MEDIA:        Object.keys(M_snap).length  > 0,
        VIDEO_ENGINE: Object.keys(VE_snap).length > 0
      },
      counts: {
        f_keys:       fKeys,
        media_videos: videos,
        media_audio:  audioCount
      },
      storage: storageInfo
    };
  }

  /**
   * Guarda snapshot seguro del curso actual en el backend.
   *
   * Routing por tamaño (Fase 5):
   *   ≤ 2 MB  → postgres_json  (snapshot completo en PostgreSQL JSONB)
   *   > 2 MB  → google_drive   (JSON Blob → Drive, solo metadata en PostgreSQL)
   *   > 25 MB → REQUIERE Drive; bloquea si no está conectado
   *
   * NO toca IndexedDB ni borra nada local.
   * @param {function} [onDone] — callback(ok, versionData)
   */
  function backendSaveCloudCopy(onDone) {
    if (!backendIsEnabled()) {
      _backendShowMsg('cloud-save-msg',
        '☁️ La nube está desactivada. Cursia sigue funcionando en modo local.', 'warn');
      if (typeof onDone === 'function') onDone(false);
      return;
    }

    // ── Verificar sesión antes de continuar ────────────────────────────────
    if (!window.SB_USER) {
      _backendShowMsg('cloud-save-msg',
        '🔐 Inicia sesión para guardar cursos en la nube.', 'warn');
      if (typeof onDone === 'function') onDone(false);
      return;
    }

    // ── 1. Construir snapshot seguro
    var builtSnap = backendBuildSnapshot();
    var estimate  = builtSnap._estimate;

    // Snapshot limpio (sin campo interno _estimate)
    var cleanSnap = {
      D:            builtSnap.D,
      F:            builtSnap.F,
      MEDIA:        builtSnap.MEDIA,
      VIDEO_ENGINE: builtSnap.VIDEO_ENGINE,
      metadata:     builtSnap.metadata
    };

    var sizeBytes = estimate.bytes;
    var sizeHuman = estimate.human;

    // ── 2. Decidir estrategia según tamaño y Drive
    var driveConnected = (typeof window.gdriveIsConnected === 'function')
                         ? window.gdriveIsConnected()
                         : false;
    var needsDrive     = sizeBytes > _SIZE_DRIVE_THRESHOLD;
    var mustUseDrive   = sizeBytes > _SIZE_BLOCK_MB;

    // > 25 MB y Drive no conectado → bloquear
    if (mustUseDrive && !driveConnected) {
      _backendShowMsg('cloud-save-msg',
        '🚫 Este curso es muy grande (' + sizeHuman + '). ' +
        'Conecta Google Drive (Configuración → Integraciones) para guardar copias en nube sin saturar la base de datos.',
        'error');
      if (typeof onDone === 'function') onDone(false);
      return;
    }

    // > 2 MB y Drive no conectado → advertir y ofrecer cancelar
    if (needsDrive && !driveConnected) {
      var proceed = window.confirm(
        '📦 Este curso es grande (' + sizeHuman + ').\n\n' +
        'Sin Google Drive conectado el snapshot se guardará en la base de datos, ' +
        'lo que puede ser lento para cursos pesados.\n\n' +
        'Recomendado: conectar Drive en Configuración → Integraciones.\n\n' +
        '¿Deseas guardar en base de datos de todas formas?'
      );
      if (!proceed) {
        _backendShowMsg('cloud-save-msg', '⏸ Guardado cancelado. Conecta Drive para cursos grandes.', 'warn');
        if (typeof onDone === 'function') onDone(false);
        return;
      }
      // Forzar postgres_json aunque sea grande
      needsDrive = false;
    }

    // > 5 MB y postgres_json → confirmación extra
    if (!needsDrive && sizeBytes > _SIZE_WARN_MB) {
      var goAhead = window.confirm(
        'La copia en nube pesa aproximadamente ' + sizeHuman + '.\n¿Deseas continuar?'
      );
      if (!goAhead) {
        _backendShowMsg('cloud-save-msg', '⏸ Guardado cancelado por el usuario.', 'warn');
        if (typeof onDone === 'function') onDone(false);
        return;
      }
    }

    // ── 3. Health check
    _backendShowMsg('cloud-save-msg', '⏳ Conectando con el backend…', 'info');

    backendHealthCheck().then(function (health) {
      if (!health.ok) {
        var errMsg = health.error === 'no_session'
          ? '🔐 Inicia sesión para guardar en la nube.'
          : '❌ No se pudo guardar en nube. Tu curso sigue guardado localmente.';
        var errType = health.error === 'no_session' ? 'warn' : 'error';
        _backendShowMsg('cloud-save-msg', errMsg, errType);
        _renderBackendPanel();
        if (typeof onDone === 'function') onDone(false);
        return;
      }

      var currentD = (typeof D !== 'undefined' ? D : {}) || {};

      // ── 4. Función que guarda la versión (llamada después de resolver el courseId)
      function _doSaveVersion(courseId) {

        // ── Path A: snapshot pequeño → postgres_json ──────────────
        if (!needsDrive) {
          _backendShowMsg('cloud-save-msg', '⏳ Guardando versión en base de datos… (' + sizeHuman + ')', 'info');

          var manifest = _buildManifest(cleanSnap, {
            provider:  'postgres_json',
            strategy:  'full_json'
          });
          var vPayload = {
            snapshotJson:     cleanSnap,
            storageProvider:  'postgres_json',
            snapshotStrategy: 'full_json',
            snapshotSizeBytes: sizeBytes,
            snapshotSizeHuman: sizeHuman,
            manifestJson:     manifest
          };

          backendCreateCourseVersion(courseId, vPayload).then(function (vRes) {
            _handleVersionResult(vRes, courseId, 'postgres_json', null, null);
          });
          return;
        }

        // ── Path B: snapshot grande → google_drive ────────────────
        _backendShowMsg('cloud-save-msg', '⏳ Subiendo snapshot a Google Drive… (' + sizeHuman + ')', 'info');

        var snapBlob = new Blob(
          [JSON.stringify(cleanSnap)],
          { type: 'application/json' }
        );
        var courseName  = currentD.nombre || currentD.title || 'curso';
        var driveFilename = 'cursia-snapshot-' + (currentD.backendCourseId || courseId) +
                            '-' + Date.now() + '.json';

        var driveOptions = {};
        if (currentD.backendCloudMeta && currentD.backendCloudMeta.storageFolderId) {
          driveOptions.folderId = currentD.backendCloudMeta.storageFolderId;
        }
        driveOptions.description   = 'Snapshot de "' + courseName + '" generado por Cursia';
        driveOptions.appProperties = { cursia_course_id: String(courseId), strategy: 'external_file' };

        window.gdriveSaveFile(snapBlob, driveFilename, 'application/json', driveOptions)
          .then(function (driveRes) {
            if (!driveRes.ok) {
              // Drive falló → intentar fallback en postgres si no es mustUseDrive
              if (!mustUseDrive) {
                _backendShowMsg('cloud-save-msg',
                  '⚠️ No se pudo subir a Drive (' + driveRes.error + '). Guardando en base de datos…', 'warn');

                var manifest2 = _buildManifest(cleanSnap, { provider: 'postgres_json', strategy: 'full_json' });
                backendCreateCourseVersion(courseId, {
                  snapshotJson:     cleanSnap,
                  storageProvider:  'postgres_json',
                  snapshotStrategy: 'full_json',
                  snapshotSizeBytes: sizeBytes,
                  snapshotSizeHuman: sizeHuman,
                  manifestJson:     manifest2
                }).then(function (vRes) {
                  _handleVersionResult(vRes, courseId, 'postgres_json', null, null);
                });
              } else {
                _backendShowMsg('cloud-save-msg',
                  '❌ No se pudo subir a Drive: ' + driveRes.error, 'error');
                if (typeof onDone === 'function') onDone(false);
              }
              return;
            }

            // Drive OK → enviar solo metadata al backend
            _backendShowMsg('cloud-save-msg', '⏳ Registrando metadatos en el backend…', 'info');

            var manifest3 = _buildManifest(cleanSnap, {
              provider:  'google_drive',
              file_id:   driveRes.fileId,
              file_url:  driveRes.webViewLink,
              strategy:  'external_file'
            });

            backendCreateCourseVersion(courseId, {
              snapshotJson:     null,
              storageProvider:  'google_drive',
              storageFileId:    driveRes.fileId,
              storageFileUrl:   driveRes.webViewLink,
              snapshotStrategy: 'external_file',
              snapshotSizeBytes: sizeBytes,
              snapshotSizeHuman: sizeHuman,
              manifestJson:     manifest3
            }).then(function (vRes) {
              _handleVersionResult(vRes, courseId, 'google_drive', driveRes.fileId, driveRes.webViewLink);
            });
          });
      }

      // ── 5. Callback unificado post-versión ────────────────────────
      function _handleVersionResult(vRes, courseId, provider, fileId, fileUrl) {
        if (!vRes.ok) {
          _backendShowMsg('cloud-save-msg',
            '❌ No se pudo guardar en nube. Tu curso sigue guardado localmente.', 'error');
          if (typeof onDone === 'function') onDone(false);
          return;
        }

        var vNum = vRes.data && vRes.data.versionNumber;

        // Actualizar D.backendCloudMeta con campos de storage
        currentD.backendCloudMeta = {
          courseId:          courseId,
          lastVersionNumber: vNum || null,
          lastSavedAt:       new Date().toISOString(),
          lastSnapshotSize:  sizeHuman,
          lastSnapshotBytes: sizeBytes,
          backendUrl:        _baseUrl(),
          storageProvider:   provider,
          storageFileId:     fileId   || null,
          storageFileUrl:    fileUrl  || null
        };
        if (typeof autoSave === 'function') {
          try { autoSave(); } catch (e) {}
        }

        var vLabel     = vNum ? 'v' + vNum : '?';
        var provLabel  = provider === 'google_drive' ? ' · ☁ Google Drive' : ' · 🗄 PostgreSQL';
        _backendShowMsg('cloud-save-msg',
          '✅ Copia guardada. Versión ' + vLabel + ' · ' + sizeHuman + provLabel, 'ok');

        // Invalidar caché de versiones para que el próximo "Ver versiones" recargue
        if (typeof _cloudCoursesState !== 'undefined' && _cloudCoursesState.versions) {
          delete _cloudCoursesState.versions[courseId];
        }

        setTimeout(_renderBackendPanel, 80);
        if (typeof onDone === 'function') onDone(true, vRes.data);
      }

      // ── ¿Ya existe un curso vinculado?
      if (currentD.backendCourseId) {
        _doSaveVersion(currentD.backendCourseId);
        return;
      }

      // ── Crear curso en backend
      _backendShowMsg('cloud-save-msg', '⏳ Registrando curso en la nube…', 'info');
      var coursePayload = {
        title:  currentD.nombre || currentD.title  || 'Curso sin título',
        sector: currentD.sector || 'general',
        level:  currentD.nivel  || currentD.level  || '',
        status: 'draft',
        // Guardar el UUID del cliente en metadata para poder hacer match con artifacts en nube
        metadata: {
          courseId: window.ACTIVE_COURSE_ID || null
        }
      };

      backendCreateCourse(coursePayload).then(function (cRes) {
        if (!cRes.ok) {
          _backendShowMsg('cloud-save-msg',
            '❌ No se pudo guardar en nube. Tu curso sigue guardado localmente.', 'error');
          if (typeof onDone === 'function') onDone(false);
          return;
        }
        var newId = cRes.data && cRes.data.id;
        if (!newId) {
          _backendShowMsg('cloud-save-msg',
            '❌ No se pudo guardar en nube. Tu curso sigue guardado localmente.', 'error');
          if (typeof onDone === 'function') onDone(false);
          return;
        }
        currentD.backendCourseId = newId;
        if (typeof autoSave === 'function') {
          try { autoSave(); } catch (e) {}
        }
        _doSaveVersion(newId);
      });
    });
  }

  // ──────────────────────────────────────────────────────────────
  // FASE 5.2 — RESTAURAR DESDE NUBE
  // ──────────────────────────────────────────────────────────────

  /**
   * Obtiene una versión específica de un curso desde el backend.
   * @param {number} courseId
   * @param {number} versionId
   * @returns {Promise<{ok, data}|{ok:false, error}>}
   */
  function backendGetCourseVersion(courseId, versionId) {
    return backendApiRequest(
      '/api/v1/courses/' + courseId + '/versions/' + versionId,
      { method: 'GET' }
    );
  }

  /**
   * Costo real+estimado del curso (tokens reales de Claude + tarifas
   * configuradas para video/audio) — misma fuente que usa el panel Admin.
   * @param {number|string} courseId
   * @returns {Promise<{ok:true,data:object}|{ok:false,error:string}>}
   */
  function backendGetCourseCost(courseId) {
    return backendApiRequest('/api/v1/courses/' + courseId + '/cost', { method: 'GET' });
  }

  /**
   * Carga el snapshot de una versión, ya sea desde postgres_json o Google Drive.
   * @param {number} courseId
   * @param {number} versionId
   * @returns {Promise<{ok:true, snapshot, version}|{ok:false, error}>}
   */
  async function backendLoadSnapshotFromVersion(courseId, versionId) {
    var vRes = await backendGetCourseVersion(courseId, versionId);
    if (!vRes.ok) {
      return { ok: false, error: vRes.error || 'No se pudo obtener la versión' };
    }

    var version  = vRes.data;
    var provider = version.storageProvider || version.storage_provider || 'postgres_json';

    // ── Path A: postgres_json ──────────────────────────────────
    if (provider === 'postgres_json') {
      var snap = version.snapshotJson || version.snapshot_json;
      if (!snap || typeof snap !== 'object') {
        return { ok: false, error: 'La versión postgres_json no contiene snapshot' };
      }
      return { ok: true, snapshot: snap, version: version };
    }

    // ── Path B: google_drive ───────────────────────────────────
    if (provider === 'google_drive') {
      var fileId = version.storageFileId || version.storage_file_id;
      if (!fileId) {
        return { ok: false, error: 'La versión Drive no tiene fileId registrado' };
      }
      if (typeof window.gdriveIsConnected !== 'function' || !window.gdriveIsConnected()) {
        return { ok: false, error: 'drive_not_connected' };
      }
      var dlRes = await window.gdriveDownloadFile(fileId);
      if (!dlRes.ok) {
        return { ok: false, error: dlRes.error || 'Error al descargar de Drive' };
      }
      if (!dlRes.json || typeof dlRes.json !== 'object') {
        return { ok: false, error: 'No se pudo parsear el JSON descargado de Drive' };
      }
      return { ok: true, snapshot: dlRes.json, version: version };
    }

    return { ok: false, error: 'Proveedor de almacenamiento no soportado: ' + provider };
  }

  /**
   * Valida que un snapshot tenga D y F.
   * Normaliza MEDIA y VIDEO_ENGINE si faltan.
   * @param {object} snapshot
   * @returns {{ valid:boolean, error?:string }}
   */
  function backendValidateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return { valid: false, error: 'Snapshot inválido o nulo' };
    }
    if (!snapshot.D || typeof snapshot.D !== 'object') {
      return { valid: false, error: 'El snapshot no contiene D (datos del curso)' };
    }
    if (!snapshot.F || typeof snapshot.F !== 'object') {
      return { valid: false, error: 'El snapshot no contiene F (archivos generados)' };
    }
    return { valid: true };
  }

  /**
   * Crea un backup local del estado actual antes de restaurar.
   * Intenta IndexedDB primero, fallback a localStorage.
   * @returns {object} El backup creado
   */
  function backendCreateLocalRestoreBackup() {
    var rawD  = (typeof D            !== 'undefined' ? D            : null) || {};
    var rawF  = (typeof F            !== 'undefined' ? F            : null) || {};
    var rawM  = (typeof MEDIA        !== 'undefined' ? MEDIA        : null) || {};
    var rawVE = window.VIDEO_ENGINE || {};

    var backup = {
      D:            rawD,
      F:            rawF,
      MEDIA:        rawM,
      VIDEO_ENGINE: rawVE,
      createdAt:    new Date().toISOString(),
      reason:       'before_cloud_restore'
    };

    // Intentar IndexedDB (si _idbPut está disponible en el scope global)
    if (typeof _idbPut === 'function') {
      try { _idbPut('meta', 'CURSIA_RESTORE_BACKUP_LAST', backup); } catch (e) {}
    }

    // Fallback localStorage
    try {
      localStorage.setItem('CURSIA_RESTORE_BACKUP_LAST', JSON.stringify(backup));
    } catch (e) {
      console.warn('[Cursia] Backup local en localStorage falló:', e);
    }

    return backup;
  }

  /**
   * Aplica un snapshot validado al estado global del curso.
   * Reemplaza D, F, MEDIA, VIDEO_ENGINE y llama autoSave.
   *
   * @param {object} snapshot  — snapshot ya validado
   * @param {object} [options] — { skipNavigation: boolean }
   * @returns {{ ok:boolean, error?:string }}
   */
  function backendRestoreSnapshot(snapshot, options) {
    var opts     = options || {};
    var validation = backendValidateSnapshot(snapshot);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    // Normalizar campos opcionales
    var safeMedia = snapshot.MEDIA        || { videos: {}, audio: {} };
    var safeVE    = snapshot.VIDEO_ENGINE || { status: 'idle' };

    // Crear backup antes de tocar el estado
    backendCreateLocalRestoreBackup();

    // ── Restaurar D ──
    try {
      Object.keys(D).forEach(function (k) { delete D[k]; });
      Object.assign(D, snapshot.D);
    } catch (e) {
      window.D = Object.assign({}, snapshot.D);
    }

    // ── Restaurar F ──
    try {
      Object.keys(F).forEach(function (k) { delete F[k]; });
      Object.assign(F, snapshot.F);
    } catch (e) {
      window.F = Object.assign({}, snapshot.F);
    }

    // ── Restaurar MEDIA ──
    try {
      if (typeof MEDIA !== 'undefined' && MEDIA && typeof MEDIA === 'object') {
        Object.keys(MEDIA).forEach(function (k) { delete MEDIA[k]; });
        Object.assign(MEDIA, safeMedia);
      } else {
        window.MEDIA = Object.assign({}, safeMedia);
      }
    } catch (e) {
      window.MEDIA = Object.assign({}, safeMedia);
    }

    // ── Restaurar VIDEO_ENGINE ──
    window.VIDEO_ENGINE = Object.assign({}, safeVE);

    // Persistir
    if (typeof autoSave === 'function') {
      try { autoSave(); } catch (e) {}
    }

    // Navegar al panel de config (panel principal del editor)
    if (!opts.skipNavigation && typeof go === 'function') {
      try { go('config'); } catch (e) {}
    }

    return { ok: true };
  }

  function validateContentSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return { valid: false, error: 'Snapshot inválido o nulo' };
    }
    var snapType = snapshot.type || null;
    if (snapType && snapType !== 'content_snapshot') {
      return { valid: false, error: 'El artifact no es un content_snapshot válido' };
    }
    if (!snapshot.D || typeof snapshot.D !== 'object') {
      return { valid: false, error: 'El snapshot no contiene D (datos del curso)' };
    }
    if (!snapshot.F || typeof snapshot.F !== 'object') {
      return { valid: false, error: 'El snapshot no contiene F (archivos generados)' };
    }
    return { valid: true };
  }

  function getLatestContentSnapshotArtifact(courseId, _attempt) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    _attempt = _attempt || 0;
    if (!courseId || typeof artifactList !== 'function') return Promise.resolve({ ok: false, error: 'missing_course_id' });
    return artifactList({ course_id: String(courseId), type: 'content_snapshot' }).then(function (res) {
      if (!res.ok || !res.data || !res.data.length) {
        // El job del worker puede marcarse "completed" un instante antes de que
        // el artifact quede visible en artifactList (propagación) — reintentar
        // antes de asumir que no existe y descartar todo el contenido ya generado.
        if (_attempt < 4) {
          return new Promise(function (resolve) { setTimeout(resolve, 3000); })
            .then(function () { return getLatestContentSnapshotArtifact(courseId, _attempt + 1); });
        }
        return { ok: false, error: 'snapshot_not_found' };
      }
      var artifact = res.data.slice().sort(function (a, b) {
        return new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0);
      })[0];
      return { ok: true, artifact: artifact };
    }).catch(function (e) {
      return { ok: false, error: e && e.message ? e.message : 'artifact_list_failed' };
    });
  }

  /**
   * Id del artifact más reciente de un tipo dado, para un curso — genérico,
   * reutilizado por el empaquetado final (content_snapshot, h5p_snapshot,
   * audio_welcome, audiobook, gamma_snapshot).
   */
  function getLatestArtifactId(courseId, type) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId || typeof artifactList !== 'function') return Promise.resolve(null);
    return artifactList({ course_id: String(courseId), type: type }).then(function (res) {
      if (!res.ok || !res.data || !res.data.length) return null;
      var sorted = res.data.slice().sort(function (a, b) {
        return new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0);
      });
      return sorted[0].id;
    }).catch(function () { return null; });
  }

  function _fetchJsonFromUrl(url) {
    if (!url) return Promise.resolve({ ok: false, error: 'missing_url' });
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      return { ok: true, json: json };
    }).catch(function (e) {
      return { ok: false, error: e && e.message ? e.message : 'json_fetch_failed' };
    });
  }

  /**
   * Descarga y parsea el JSON de cualquier artifact por su id (mismo patrón que
   * openContentSnapshotArtifact, pero sin depender de course_id ni de un tipo fijo).
   */
  function openArtifactJsonById(artifactId) {
    if (!artifactId) return Promise.resolve({ ok: false, error: 'missing_artifact_id' });
    if (typeof artifactDownloadUrl !== 'function') {
      return Promise.resolve({ ok: false, error: 'artifact_download_unavailable' });
    }
    return artifactDownloadUrl(artifactId).then(function (urlRes) {
      if (!urlRes.ok) return { ok: false, error: urlRes.error || 'download_url_failed' };
      if (urlRes.url) {
        return _fetchJsonFromUrl(urlRes.url).then(function (dlRes) {
          if (!dlRes.ok) return { ok: false, error: dlRes.error || 'json_download_failed' };
          return { ok: true, json: dlRes.json };
        });
      }
      if (urlRes.storagePath && window.SB) {
        var bucket = urlRes.bucket || 'cursia-artifacts';
        return window.SB.storage.from(bucket).createSignedUrl(urlRes.storagePath, 3600).then(function (signRes) {
          var signedUrl = signRes && signRes.data && signRes.data.signedUrl;
          if (!signedUrl) return { ok: false, error: 'sign_failed' };
          return _fetchJsonFromUrl(signedUrl).then(function (dlRes) {
            if (!dlRes.ok) return { ok: false, error: dlRes.error || 'json_download_failed' };
            return { ok: true, json: dlRes.json };
          });
        }).catch(function (e) {
          return { ok: false, error: e && e.message ? e.message : 'sign_failed' };
        });
      }
      return { ok: false, error: 'unsupported_download_method' };
    });
  }

  function openContentSnapshotArtifact(courseId) {
    return getLatestContentSnapshotArtifact(courseId).then(function (latest) {
      if (!latest.ok || !latest.artifact) return latest;
      if (typeof artifactDownloadUrl !== 'function') {
        return { ok: false, error: 'artifact_download_unavailable' };
      }
      return artifactDownloadUrl(latest.artifact.id).then(function (urlRes) {
        if (!urlRes.ok) return { ok: false, error: urlRes.error || 'download_url_failed' };
        if (urlRes.url) {
          return _fetchJsonFromUrl(urlRes.url).then(function (dlRes) {
            if (!dlRes.ok) return { ok: false, error: dlRes.error || 'snapshot_download_failed' };
            return { ok: true, snapshot: dlRes.json, artifact: latest.artifact };
          });
        }
        if (urlRes.storagePath && window.SB) {
          var bucket = urlRes.bucket || 'cursia-artifacts';
          return window.SB.storage.from(bucket).createSignedUrl(urlRes.storagePath, 3600).then(function (signRes) {
            var signedUrl = signRes && signRes.data && signRes.data.signedUrl;
            if (!signedUrl) return { ok: false, error: 'sign_failed' };
            return _fetchJsonFromUrl(signedUrl).then(function (dlRes) {
              if (!dlRes.ok) return { ok: false, error: dlRes.error || 'snapshot_download_failed' };
              return { ok: true, snapshot: dlRes.json, artifact: latest.artifact };
            });
          }).catch(function (e) {
            return { ok: false, error: e && e.message ? e.message : 'sign_failed' };
          });
        }
        return { ok: false, error: 'unsupported_download_method' };
      });
    });
  }

  function _syncUiFromContentSnapshotD(d) {
    d = d || {};
    var fieldMap = {
      'c-nombre': d.nombre || '',
      'c-comp': d.comp || '',
      'c-pais': d.pais || '',
      'c-ciudad': d.ciudad || '',
      'c-sector': d.sector || '',
      'c-mid': d.mid || '',
      'c-lms': d.lms || '',
      'c-obj': d.obj || ''
    };
    Object.keys(fieldMap).forEach(function (fid) {
      var el = document.getElementById(fid);
      if (el) el.value = fieldMap[fid];
    });

    var mods = Array.isArray(d.mods) ? d.mods : [];
    function _modName(i) { return mods[i] && mods[i].n ? mods[i].n : ''; }
    function _capName(mi, ci) {
      return mods[mi] && Array.isArray(mods[mi].caps) && mods[mi].caps[ci] ? mods[mi].caps[ci] : '';
    }
    var courseFields = {
      'm1-n': _modName(0), 'm1-c1': _capName(0, 0), 'm1-c2': _capName(0, 1), 'm1-c3': _capName(0, 2),
      'm2-n': _modName(1), 'm2-c4': _capName(1, 0), 'm2-c5': _capName(1, 1), 'm2-c6': _capName(1, 2),
      'm3-n': _modName(2), 'm3-c7': _capName(2, 0), 'm3-c8': _capName(2, 1), 'm3-c9': _capName(2, 2)
    };
    Object.keys(courseFields).forEach(function (fid) {
      var el = document.getElementById(fid);
      if (el) el.value = courseFields[fid];
    });

    if (typeof SEL !== 'undefined' && SEL && typeof SEL === 'object') {
      if (d.nivel) SEL.nivel = d.nivel;
      if (d.tono) SEL.tono = d.tono;
      if (d.contexto) SEL.contexto = d.contexto;
      document.querySelectorAll('.chips').forEach(function (g) {
        var gid = g.id.replace('cp-', '');
        if (!SEL[gid]) return;
        g.querySelectorAll('.chip').forEach(function (c) {
          c.classList.toggle('on', c.dataset.v === SEL[gid]);
        });
      });
    }
  }

  function _applyContentSnapshot(snapshot, courseId) {
    var validation = validateContentSnapshot(snapshot);
    if (!validation.valid) return { ok: false, error: validation.error };

    var targetCourseId = courseId || (snapshot.course && snapshot.course.id) || window.ACTIVE_COURSE_ID;
    if (!targetCourseId) return { ok: false, error: 'missing_course_id' };

    if (typeof backendCreateLocalRestoreBackup === 'function') {
      try { backendCreateLocalRestoreBackup(); } catch (e) {}
    }

    try {
      window.ACTIVE_COURSE_ID = String(targetCourseId);
      localStorage.setItem('cc_active_course_id', String(targetCourseId));
    } catch (e) {
      window.ACTIVE_COURSE_ID = String(targetCourseId);
    }

    try {
      Object.keys(D).forEach(function (k) { delete D[k]; });
      Object.assign(D, snapshot.D);
    } catch (e) {
      window.D = Object.assign({}, snapshot.D);
    }

    try {
      Object.keys(F).forEach(function (k) { delete F[k]; });
      Object.assign(F, snapshot.F);
    } catch (e) {
      window.F = Object.assign({}, snapshot.F);
    }

    _syncUiFromContentSnapshotD(snapshot.D);

    if (typeof collect === 'function') {
      try { collect(); } catch (e) {}
    }
    try {
      Object.assign(D, snapshot.D);
    } catch (e) {
      window.D = Object.assign({}, snapshot.D);
    }

    if (typeof saveCourseFiles === 'function') {
      try { saveCourseFiles(); } catch (e) {}
    }
    if (typeof autoSave === 'function') {
      try { autoSave(); } catch (e) {}
    }
    if (typeof updSidebarStatus === 'function') {
      try { updSidebarStatus(); } catch (e) {}
    }
    if (typeof updDashboard === 'function') {
      try { updDashboard(); } catch (e) {}
    }

    return { ok: true };
  }

  function restoreContentSnapshotFromCloud(courseId) {
    return openContentSnapshotArtifact(courseId).then(function (openRes) {
      if (!openRes.ok || !openRes.snapshot) return openRes;
      var restoreRes = _applyContentSnapshot(openRes.snapshot, courseId);
      if (!restoreRes.ok) return restoreRes;
      return {
        ok: true,
        snapshot: openRes.snapshot,
        artifact: openRes.artifact
      };
    }).catch(function (e) {
      return { ok: false, error: e && e.message ? e.message : 'restore_failed' };
    });
  }

  /**
   * Flujo completo de restauración de una versión desde la nube.
   * Muestra confirmación, carga, valida, backup, restaura y notifica.
   *
   * @param {number} courseId
   * @param {number} versionId
   */
  async function backendRestoreCourseVersion(courseId, versionId) {
    // 1. Confirmación del usuario
    var confirmed = window.confirm(
      'Esto reemplazará el curso actual en esta sesión.\n\n' +
      'Se creará una copia local de respaldo antes de continuar.\n\n' +
      '¿Deseas restaurar esta versión?'
    );
    if (!confirmed) return;

    // 2. Indicar progreso
    _backendShowMsg('cloud-save-msg', '⏳ Cargando versión desde la nube…', 'info');

    // 3. Cargar snapshot (postgres_json o Drive)
    var loadRes = await backendLoadSnapshotFromVersion(courseId, versionId);
    if (!loadRes.ok) {
      var errMsg = (loadRes.error === 'drive_not_connected')
        ? '❌ Google Drive no está conectado. Conéctalo desde Configuración → Integraciones.'
        : '❌ No se pudo cargar la versión: ' + _esc(loadRes.error || 'Error desconocido');
      _backendShowMsg('cloud-save-msg', errMsg, 'error');
      return;
    }

    // 4. Validar snapshot
    var validation = backendValidateSnapshot(loadRes.snapshot);
    if (!validation.valid) {
      _backendShowMsg('cloud-save-msg',
        '❌ Snapshot corrupto: ' + _esc(validation.error), 'error');
      return;
    }

    // 5. Restaurar
    _backendShowMsg('cloud-save-msg', '⏳ Restaurando curso…', 'info');
    var restoreRes = backendRestoreSnapshot(loadRes.snapshot);
    if (!restoreRes.ok) {
      _backendShowMsg('cloud-save-msg',
        '❌ Error al restaurar: ' + _esc(restoreRes.error), 'error');
      return;
    }

    // 6. Mensaje de éxito y refrescar panel
    _backendShowMsg('cloud-save-msg',
      '✅ Curso restaurado desde nube. Se guardó una copia local de respaldo del curso anterior.',
      'ok');
    setTimeout(_renderBackendPanel, 200);
  }

  // ──────────────────────────────────────────────────────────────
  // PANEL UI — _renderBackendPanel (Fase 4.1 — UI última copia)
  // ──────────────────────────────────────────────────────────────

  function _renderBackendPanel() {
    var panel = document.getElementById('panel-backend-body');
    if (!panel) return;

    if (!_canAccessBackendPanel()) {
      panel.innerHTML =
        '<div style="padding:10px 0;color:rgba(3, 10, 38,.62);font-size:12.5px;line-height:1.7;">' +
          'Tus cursos se guardan automáticamente para que puedas continuar después.' +
        '</div>';
      return;
    }

    var enabled = backendIsEnabled();
    var status  = window.CURSIA_BACKEND.status;
    var url     = window.CURSIA_BACKEND.baseUrl || 'http://localhost:3000';
    var err     = window.CURSIA_BACKEND.lastError;

    // Leer D.backendCloudMeta de forma segura
    var meta     = (typeof D !== 'undefined' && D && D.backendCloudMeta) ? D.backendCloudMeta : null;
    var courseId = (typeof D !== 'undefined' && D && D.backendCourseId)  ? D.backendCourseId  : null;

    // Badges
    var badgeColor = { unknown:'#9ca3af', connected:'#22c55e', error:'#ef4444', disabled:'#6b7280' };
    var badgeLabel = { unknown:'Sin verificar', connected:'Conectado', error:'Error de conexión', disabled:'Desactivado' };
    var bc = badgeColor[status] || badgeColor.unknown;
    var bl = badgeLabel[status] || status;

    // Actualizar topbar badge
    var topBadge = document.getElementById('backend-status-badge');
    if (topBadge) {
      var topColors = { connected:'#22c55e', error:'#ef4444', unknown:'#9ca3af', disabled:'#6b7280' };
      var topLabels = { connected:'Conectado', error:'Error', unknown:'Sin verificar', disabled:'Nube desactivada' };
      var tc = topColors[status] || topColors.unknown;
      topBadge.style.color       = tc;
      topBadge.style.background  = tc + '22';
      topBadge.style.borderColor = tc + '55';
      topBadge.textContent = topLabels[status] || status;
    }
    _updateBackendSidebarBadge();

    // ── Construir HTML
    var html = [];

    // Modo desactivado — aviso
    if (!enabled) {
      html.push(
        '<div style="padding:10px 0 8px;color:rgba(3, 10, 38,.55);font-size:12.5px;">' +
        '☁️ La nube está desactivada para pruebas internas. El usuario final no debería usar esta opción.</div>'
      );
    }

    // Estado badge
    html.push(
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">',
      '<span style="font-size:11px;font-weight:700;letter-spacing:.05em;color:rgba(3, 10, 38,.5);">ESTADO</span>',
      '<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;',
        'background:', bc, '22;border:1px solid ', bc, '55;font-size:11.5px;font-weight:600;color:', bc, ';">',
        '<span style="width:6px;height:6px;border-radius:50%;background:', bc, ';display:inline-block;"></span>',
        bl,
      '</span>',
      err ? '<span style="font-size:11px;color:#ef4444;opacity:.8;">' + _esc(err) + '</span>' : '',
      '</div>'
    );

    // URL input
    html.push(
      '<div class="field" style="margin-bottom:10px;">',
        '<label style="font-size:10.5px;font-weight:700;letter-spacing:.05em;color:rgba(3, 10, 38,.5);">URL DEL SERVICIO</label>',
        '<div style="display:flex;gap:6px;">',
          '<input id="backend-url-input" type="url" placeholder="http://localhost:3000"',
            ' value="', _esc(url), '"',
            ' style="flex:1;padding:7px 10px;border-radius:7px;border:1px solid var(--b2);',
            'background:var(--s3);color:var(--t1);font-size:12px;">',
          '<button onclick="backendSetBaseUrl(document.getElementById(\'backend-url-input\').value);_renderBackendPanel();"',
            ' class="btn btn-g" style="font-size:11px;padding:0 10px;">Guardar</button>',
        '</div>',
      '</div>'
    );

    // ¿Hay sesión Supabase activa?
    var hasSession = !!(window.SB_USER);

    // Botones
    html.push('<div style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:12px;">');
    if (!enabled) {
      html.push('<button class="btn btn-p" onclick="enableBackendCloud()">☁️ Activar nube (pruebas)</button>');
    } else {
      html.push(
        '<button class="btn btn-g" onclick="disableBackendCloud()" style="color:var(--t3);" title="Solo para pruebas internas. Puede afectar el guardado automático.">✕ Desactivar nube (pruebas)</button>',
        '<button class="btn btn-g" onclick="_backendTestConnection()">🔌 Probar conexión</button>'
      );
      if (hasSession) {
        html.push(
          '<button class="btn btn-g" id="cloud-save-btn" onclick="backendSaveCloudCopy()"',
            ' style="border-color:rgba(34,197,94,.4);color:var(--green);">💾 Guardar copia manual</button>'
        );
      } else {
        html.push(
          '<button class="btn btn-g" disabled title="Inicia sesión para usar las acciones manuales"',
            ' style="opacity:.4;cursor:not-allowed;">💾 Guardar copia manual</button>'
        );
      }
    }
    html.push('</div>');

    // Banner de sesión requerida (solo si backend activo y sin login)
    if (enabled && !hasSession) {
      html.push(
        '<div style="margin-bottom:12px;padding:9px 12px;border-radius:8px;',
          'background:rgba(248,181,0,.07);border:1px solid rgba(248,181,0,.2);',
          'font-size:12px;color:rgba(3, 10, 38,.65);line-height:1.6;">',
          '🔐 <strong style="color:rgba(3, 10, 38,.85);">Inicia sesión</strong> para usar este panel interno. ',
          '<span style="color:rgba(3, 10, 38,.45);">El guardado automático del usuario final no se configura aquí.</span>',
        '</div>'
      );
    }

    // Mensaje de operación
    html.push('<div id="cloud-save-msg" style="font-size:12px;min-height:18px;margin-bottom:10px;"></div>');

    // ── Sección Preparar curso (flujo híbrido) ──────────────────────────
    if (enabled && hasSession) {
      html.push(_renderHybridSection());
    }

    // ── UI ÚLTIMA COPIA EN NUBE (Fase 4.1 + Fase 5 storage provider)
    if (enabled && (meta || courseId)) {
      // Calcular etiqueta de provider
      var providerLabel = '—';
      var providerColor = 'rgba(3, 10, 38,.5)';
      var providerIcon  = '';
      if (meta && meta.storageProvider) {
        if (meta.storageProvider === 'google_drive') {
          providerLabel = 'Google Drive';
          providerColor = '#4285f4';
          providerIcon  = '☁️ ';
        } else if (meta.storageProvider === 'postgres_json') {
          providerLabel = 'PostgreSQL JSON';
          providerColor = '#22c55e';
          providerIcon  = '🗄 ';
        }
      }

      html.push(
        '<div style="margin-top:12px;padding:10px 12px;border-radius:9px;',
          'background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15);">',
          '<div style="font-size:10.5px;font-weight:700;letter-spacing:.05em;',
            'color:rgba(3, 10, 38,.45);margin-bottom:7px;">ÚLTIMA COPIA EN NUBE</div>',
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px 12px;">'
      );

      if (courseId) {
        html.push(
          '<div style="font-size:11px;color:rgba(3, 10, 38,.5);">ID del curso</div>',
          '<div style="font-size:11.5px;font-weight:600;color:rgba(3, 10, 38,.85);">#', String(courseId), '</div>'
        );
      }
      if (meta && meta.lastVersionNumber != null) {
        html.push(
          '<div style="font-size:11px;color:rgba(3, 10, 38,.5);">Última versión</div>',
          '<div style="font-size:11.5px;font-weight:600;color:#22c55e;">v', String(meta.lastVersionNumber), '</div>'
        );
      }
      if (meta && meta.storageProvider) {
        html.push(
          '<div style="font-size:11px;color:rgba(3, 10, 38,.5);">Almacenamiento</div>',
          '<div style="font-size:11.5px;font-weight:600;color:', providerColor, ';">',
            providerIcon, _esc(providerLabel),
          '</div>'
        );
      }
      if (meta && meta.lastSnapshotSize) {
        html.push(
          '<div style="font-size:11px;color:rgba(3, 10, 38,.5);">Tamaño</div>',
          '<div style="font-size:11.5px;font-weight:600;color:rgba(3, 10, 38,.85);">', _esc(meta.lastSnapshotSize), '</div>'
        );
      }
      if (meta && meta.lastSavedAt) {
        var savedDate = '';
        try { savedDate = new Date(meta.lastSavedAt).toLocaleString('es', { dateStyle:'short', timeStyle:'short' }); }
        catch(e) { savedDate = meta.lastSavedAt.slice(0,16).replace('T',' '); }
        html.push(
          '<div style="font-size:11px;color:rgba(3, 10, 38,.5);">Guardado el</div>',
          '<div style="font-size:11.5px;color:rgba(3, 10, 38,.7);">', _esc(savedDate), '</div>'
        );
      }
      if (meta && meta.backendUrl) {
        html.push(
          '<div style="font-size:11px;color:rgba(3, 10, 38,.5);">Servicio</div>',
          '<div style="font-size:11px;color:rgba(3, 10, 38,.5);word-break:break-all;">', _esc(meta.backendUrl), '</div>'
        );
      }

      html.push('</div>');

      // Botón "Abrir en Drive" si la última copia está en Google Drive
      if (meta && meta.storageProvider === 'google_drive' && meta.storageFileUrl) {
        html.push(
          '<div style="margin-top:8px;">',
            '<a href="', _esc(meta.storageFileUrl), '" target="_blank" rel="noopener"',
              ' style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;',
              'border-radius:7px;border:1px solid rgba(66,133,244,.35);background:rgba(66,133,244,.08);',
              'color:#4285f4;font-size:11.5px;font-weight:600;text-decoration:none;">',
              '↗ Abrir en Drive',
            '</a>',
          '</div>'
        );
      }

      html.push('</div>');
    }

    // ── Sección backup local de seguridad (Fase 5.2)
    html.push('<div id="cloud-backup-section" style="margin-top:14px;">',
      '<div style="font-size:11px;color:rgba(3, 10, 38,.3);">⏳ Verificando backup local…</div>',
    '</div>');

    // ── Sección de cursos en nube (Fase 4.2)
    html.push('<div id="cloud-courses-list" style="margin-top:14px;"></div>');

    panel.innerHTML = html.join('');
    _bindHybridActionButtons();

    // Renderizar lista de cursos sin re-renderizar el panel completo
    _renderCloudCoursesList();

    // Cargar backup local de forma async y actualizar su sección
    _localBackupUIState.checked = false;
    _localBackupUIState.backup  = null;
    backendGetLocalRestoreBackup(function () {
      _renderLocalBackupSection();
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers UI
  // ──────────────────────────────────────────────────────────────

  function _backendTestConnection() {
    _backendShowMsg('cloud-save-msg', '⏳ Probando conexión…', 'info');
    backendHealthCheck().then(function (res) {
      if (res.ok) {
        _backendShowMsg('cloud-save-msg', '✅ Servicio conectado.', 'ok');
      } else {
        _backendShowMsg('cloud-save-msg',
          '❌ No se pudo conectar. El guardado automático seguirá intentando funcionar cuando el servicio vuelva.', 'error');
      }
      _renderBackendPanel();
    });
  }

  function _backendShowMsg(elId, msg, type) {
    var el = document.getElementById(elId);
    if (!el) return;
    var colors = { ok:'#22c55e', error:'#ef4444', warn:'#f59e0b', info:'rgba(3, 10, 38,.65)' };
    el.style.color  = colors[type] || colors.info;
    el.textContent  = msg;
  }

  function _updateBackendSidebarBadge() {
    var badge = document.getElementById('st-backend');
    if (!badge) return;
    var status = window.CURSIA_BACKEND.status;
    var colors = { connected:'#22c55e', error:'#ef4444', unknown:'#9ca3af', disabled:'' };
    var color  = colors[status] || '';
    if (!window.CURSIA_BACKEND.enabled || status === 'disabled') {
      badge.style.opacity = '0';
    } else {
      badge.style.opacity    = '1';
      badge.style.background = color;
      badge.style.borderColor = color;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // FASE 5.2 — UI BACKUP LOCAL DE SEGURIDAD
  // ──────────────────────────────────────────────────────────────

  /** Estado de UI del backup (evita parpadeo: solo se carga una vez por sesión de panel) */
  var _localBackupUIState = {
    checked: false,   // true = ya se intentó cargar desde IDB/localStorage
    backup:  null     // null = no hay | object = backup válido
  };

  /**
   * Lee el backup de seguridad desde IndexedDB (primario) o localStorage (fallback).
   * @param {function} callback  — fn(backup|null)
   */
  function backendGetLocalRestoreBackup(callback) {
    // Intentar IndexedDB primero
    if (typeof _idbGet === 'function') {
      _idbGet('meta', 'CURSIA_RESTORE_BACKUP_LAST', function (result) {
        if (result && typeof result === 'object' && result.D && result.F) {
          _localBackupUIState.checked = true;
          _localBackupUIState.backup  = result;
          callback(result);
          return;
        }
        // IDB vacío → fallback localStorage
        _tryLocalStorageBackup(callback);
      });
    } else {
      _tryLocalStorageBackup(callback);
    }
  }

  function _tryLocalStorageBackup(callback) {
    try {
      var raw = localStorage.getItem('CURSIA_RESTORE_BACKUP_LAST');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.D && parsed.F) {
          _localBackupUIState.checked = true;
          _localBackupUIState.backup  = parsed;
          callback(parsed);
          return;
        }
      }
    } catch (e) {}
    _localBackupUIState.checked = true;
    _localBackupUIState.backup  = null;
    callback(null);
  }

  /**
   * Renderiza la sección de backup local dentro de #cloud-backup-section.
   * Se llama después de que IDB resuelve.
   */
  function _renderLocalBackupSection() {
    var el = document.getElementById('cloud-backup-section');
    if (!el) return;

    var backup = _localBackupUIState.backup;
    var html   = [];

    html.push(
      '<div style="margin-top:14px;padding:10px 12px;border-radius:9px;',
        'background:rgba(245,158,11,.05);border:1px solid rgba(245,158,11,.18);">',
        '<div style="font-size:10.5px;font-weight:700;letter-spacing:.05em;',
          'color:rgba(3, 10, 38,.4);margin-bottom:7px;">',
          '🛡 BACKUP LOCAL DE SEGURIDAD',
        '</div>'
    );

    if (!backup) {
      html.push(
        '<div style="font-size:12px;color:rgba(3, 10, 38,.35);">',
          'No hay backup local disponible.',
        '</div>'
      );
    } else {
      var date = '—';
      try {
        var d    = new Date(backup.createdAt);
        var mons = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
        date = d.getDate() + ' ' + mons[d.getMonth()] + ' ' + d.getFullYear() +
               ' · ' + String(d.getHours()).padStart(2,'0') + ':' +
               String(d.getMinutes()).padStart(2,'0');
      } catch (e) {}

      var reason = backup.reason === 'before_cloud_restore'
        ? 'Antes de restaurar desde nube'
        : _esc(backup.reason || '—');

      var fCount = backup.F ? Object.keys(backup.F).length : 0;

      html.push(
        '<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin-bottom:8px;">',
          '<span style="font-size:11px;color:rgba(3, 10, 38,.4);">Creado</span>',
          '<span style="font-size:11.5px;color:rgba(3, 10, 38,.75);">', date, '</span>',
          '<span style="font-size:11px;color:rgba(3, 10, 38,.4);">Razón</span>',
          '<span style="font-size:11.5px;color:rgba(3, 10, 38,.75);">', reason, '</span>',
          '<span style="font-size:11px;color:rgba(3, 10, 38,.4);">Archivos (F)</span>',
          '<span style="font-size:11.5px;color:rgba(3, 10, 38,.75);">', String(fCount), '</span>',
        '</div>',
        '<button onclick="backendRestoreLocalBackup()"',
          ' style="font-size:11.5px;padding:5px 14px;border-radius:7px;',
          'border:1px solid rgba(245,158,11,.4);background:rgba(245,158,11,.08);',
          'color:#f59e0b;cursor:pointer;">',
          '↩ Restaurar backup local',
        '</button>'
      );
    }

    html.push('</div>');
    el.innerHTML = html.join('');
  }

  /**
   * Restaura el backup local de seguridad.
   * Confirmación → validación → restore → mensaje.
   * No crea un backup-del-backup para evitar loops.
   */
  function backendRestoreLocalBackup() {
    var confirmed = window.confirm(
      'Esto reemplazará el curso actual por el backup local anterior.\n\n¿Continuar?'
    );
    if (!confirmed) return;

    _backendShowMsg('cloud-save-msg', '⏳ Cargando backup local…', 'info');

    backendGetLocalRestoreBackup(function (backup) {
      if (!backup) {
        _backendShowMsg('cloud-save-msg', '❌ No se encontró backup local.', 'error');
        return;
      }

      var validation = backendValidateSnapshot(backup);
      if (!validation.valid) {
        _backendShowMsg('cloud-save-msg',
          '❌ Backup corrupto: ' + _esc(validation.error), 'error');
        return;
      }

      // Restaurar directamente sin crear otro backup (evitar loop)
      try {
        // D
        Object.keys(D).forEach(function (k) { delete D[k]; });
        Object.assign(D, backup.D);
        // F
        Object.keys(F).forEach(function (k) { delete F[k]; });
        Object.assign(F, backup.F);
        // MEDIA
        var safeMedia = backup.MEDIA || { videos: {}, audio: {} };
        try {
          if (typeof MEDIA !== 'undefined' && MEDIA && typeof MEDIA === 'object') {
            Object.keys(MEDIA).forEach(function (k) { delete MEDIA[k]; });
            Object.assign(MEDIA, safeMedia);
          } else {
            window.MEDIA = Object.assign({}, safeMedia);
          }
        } catch (e) { window.MEDIA = Object.assign({}, safeMedia); }
        // VIDEO_ENGINE
        window.VIDEO_ENGINE = Object.assign({}, backup.VIDEO_ENGINE || { status: 'idle' });
      } catch (e) {
        _backendShowMsg('cloud-save-msg', '❌ Error al restaurar backup: ' + _esc(e.message), 'error');
        return;
      }

      if (typeof autoSave === 'function') {
        try { autoSave(); } catch (e) {}
      }
      if (typeof go === 'function') {
        try { go('config'); } catch (e) {}
      }

      _backendShowMsg('cloud-save-msg', '✅ Backup local restaurado correctamente.', 'ok');
      // Invalidar caché del estado del backup
      _localBackupUIState.checked = false;
      _localBackupUIState.backup  = null;
      setTimeout(_renderBackendPanel, 200);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Production Jobs — P0 SaaS job tracker
  //
  // Fire-and-forget: si el backend no tiene los endpoints aún o
  // está desactivado, todas las funciones retornan silenciosamente.
  // El pipeline local sigue funcionando sin interrupción.
  // ──────────────────────────────────────────────────────────────

  /**
   * Crea un production_job en el backend.
   * Llamado al inicio de startFullCourseProduction().
   * @returns {Promise<{ok, jobId?, error?}>}
   */
  function jobCreate(courseId, frontendJobId, options) {
    if (!backendIsEnabled() || !window.SB_USER) {
      return Promise.resolve({ ok: false, error: 'backend_off' });
    }
    return backendApiRequest('/api/v1/jobs', {
      method: 'POST',
      body: {
        course_id:       courseId,
        frontend_job_id: frontendJobId,
        options:         options || {},
      }
    }).then(function (res) {
      if (!res.ok) return { ok: false, error: (res.error || 'unknown') };
      // ResponseInterceptor wraps: { data: { ok, data: job } }
      // _fetchWithTimeout peels one layer: res.data = { ok, data: job }
      var payload = res.data || {};
      var job = payload.data || payload;
      if (job && job.id) {
        return { ok: true, jobId: job.id };
      }
      return { ok: false, error: 'no job id in response' };
    }).catch(function (e) {
      console.warn('[Cursia:jobs] jobCreate failed (non-blocking):', e.message);
      return { ok: false, error: e.message };
    });
  }

  /**
   * Actualiza el estado global del job.
   * Llamado en completion/failure del pipeline.
   */
  function jobUpdate(backendJobId, fields) {
    if (!backendJobId || !backendIsEnabled()) return Promise.resolve({ ok: false });
    return backendApiRequest('/api/v1/jobs/' + backendJobId, {
      method: 'PATCH',
      body: fields
    }).then(function (res) {
      return { ok: !!res.ok };
    }).catch(function () {
      return { ok: false };
    });
  }

  /**
   * Lee el estado de un job.
   */
  function jobGet(backendJobId) {
    if (!backendJobId || !backendIsEnabled()) return Promise.resolve({ ok: false });
    return backendApiRequest('/api/v1/jobs/' + backendJobId, { method: 'GET' });
  }

  /**
   * Reporta el estado de un step del pipeline.
   * Llamado desde markStepRunning/Done/Failed/Skipped.
   * Fire-and-forget: no bloquea el pipeline.
   */
  function jobReportStep(backendJobId, stepKey, status, detail, error) {
    if (!backendJobId || !backendIsEnabled()) return;
    var body = { status: status };
    if (detail) body.detail = String(detail).substring(0, 200);
    if (error)  body.error  = String(error).substring(0, 500);
    if (status === 'running')   body.started_at  = new Date().toISOString();
    if (status === 'completed' || status === 'failed' || status === 'skipped') {
      body.finished_at = new Date().toISOString();
    }
    // Fire-and-forget: don't await, don't block the pipeline
    backendApiRequest('/api/v1/jobs/' + backendJobId + '/steps/' + stepKey, {
      method: 'PATCH',
      body: body
    }).catch(function () {
      // Silent — backend step reporting is non-blocking
    });
  }

  /**
   * Lista los production_jobs del usuario, opcionalmente filtrados por course_id.
   */
  function jobList(courseId) {
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, data: [] });
    var path = '/api/v1/jobs';
    if (courseId) path += '?course_id=' + encodeURIComponent(courseId);
    return backendApiRequest(path, { method: 'GET' }).then(function (res) {
      if (!res.ok) return { ok: false, data: [] };
      // ResponseInterceptor wraps: { data: { ok, data: { jobs } } }
      var payload = res.data || {};
      var inner = payload.data || payload;
      if (Array.isArray(inner)) return { ok: true, data: inner };
      if (inner && Array.isArray(inner.jobs)) return { ok: true, data: inner.jobs };
      if (Array.isArray(payload)) return { ok: true, data: payload };
      return { ok: false, data: [] };
    }).catch(function () {
      return { ok: false, data: [] };
    });
  }

  /**
   * Actualiza courses table con production/dimensions/computed_estado.
   * Llamado al final de la producción para que Mis Cursos tenga datos frescos.
   */
  function jobSyncCourseState(courseId, production, dimensions, computedEstado) {
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false });
    return backendApiRequest('/api/v1/courses/' + encodeURIComponent(courseId), {
      method: 'PATCH',
      body: {
        production:      production,
        dimensions:       dimensions,
        computed_estado:  computedEstado,
      }
    }).then(function (res) {
      return { ok: !!res.ok };
    }).catch(function () {
      return { ok: false };
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Artifacts — P1.0 SaaS almacenamiento central
  //
  // Upload va directo a Supabase Storage desde el frontend (SB SDK).
  // Estas funciones manejan solo metadata en el backend + signed URLs.
  // Fire-and-forget: si backend off, retornan silenciosamente.
  // ──────────────────────────────────────────────────────────────

  /**
   * Registra metadata de un artifact después de subirlo a Supabase Storage.
   * @param {{ course_id, job_id, type, storage_path, storage_provider?, storage_bucket?, filename, mime_type, size_bytes, checksum_sha256?, metadata }} data
   * @returns {Promise<{ok, data?}>}
   */
  // Timeout propio (30 s, no el default de 8 s): el archivo YA se subió a
  // Storage y a menudo ya se pagó su generación (p.ej. el contenido de un
  // capítulo). Un backend lento un momento no debe tirar ese trabajo y
  // forzar a regenerarlo.
  var ARTIFACT_CREATE_TIMEOUT_MS = 30000;
  function artifactCreate(data) {
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false });
    return backendApiRequest('/api/v1/artifacts', {
      method: 'POST',
      body: data
    }, ARTIFACT_CREATE_TIMEOUT_MS).then(function (res) {
      if (!res.ok) return { ok: false, error: res.error };
      var payload = res.data || {};
      var artifact = payload.data || payload;
      return { ok: true, data: artifact };
    }).catch(function (e) {
      console.warn('[Cursia:artifacts] create failed:', e.message);
      return { ok: false, error: e.message };
    });
  }

  /**
   * Lista artifacts. Filtros opcionales: course_id, type, job_id.
   * @returns {Promise<{ok, data: Array}>}
   */
  function artifactList(filters) {
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, data: [] });
    var params = [];
    if (filters) {
      if (filters.course_id) params.push('course_id=' + encodeURIComponent(filters.course_id));
      if (filters.type)      params.push('type=' + encodeURIComponent(filters.type));
      if (filters.job_id)    params.push('job_id=' + encodeURIComponent(filters.job_id));
    }
    var path = '/api/v1/artifacts' + (params.length ? '?' + params.join('&') : '');
    return backendApiRequest(path, { method: 'GET' }).then(function (res) {
      if (!res.ok) return { ok: false, data: [] };
      var payload = res.data || {};
      var list = payload.data || payload;
      if (Array.isArray(list)) return { ok: true, data: list };
      return { ok: false, data: [] };
    }).catch(function () {
      return { ok: false, data: [] };
    });
  }

  /**
   * Lee metadata de un artifact.
   */
  function artifactGet(id) {
    if (!id || !backendIsEnabled()) return Promise.resolve({ ok: false });
    return backendApiRequest('/api/v1/artifacts/' + id, { method: 'GET' }).then(function (res) {
      if (!res.ok) return { ok: false };
      var payload = res.data || {};
      return { ok: true, data: payload.data || payload };
    }).catch(function () {
      return { ok: false };
    });
  }

  /**
   * Obtiene signed download URL para un artifact.
   * Si el backend tiene SUPABASE_SERVICE_ROLE_KEY, retorna { url, method:'backend' }.
   * Si no, retorna { storagePath, bucket, method:'frontend' } para que el frontend
   * genere la URL con SB.storage.from(bucket).createSignedUrl(path, 3600).
   * @returns {Promise<{ok, url?, storagePath?, bucket?, method?}>}
   */
  function artifactDownloadUrl(id, expiresSeconds) {
    if (!id || !backendIsEnabled()) return Promise.resolve({ ok: false });
    var path = '/api/v1/artifacts/' + id + '/download-url';
    if (expiresSeconds) path += '?expires=' + expiresSeconds;
    return backendApiRequest(path, { method: 'GET' }).then(function (res) {
      if (!res.ok) return { ok: false };
      var payload = res.data || {};
      var result = payload.data || payload;
      return {
        ok:          true,
        url:         result.url || null,
        storagePath: result.storagePath || result.storage_path || null,
        bucket:      result.bucket || 'cursia-artifacts',
        method:      result.method || 'frontend'
      };
    }).catch(function () {
      return { ok: false };
    });
  }

  /**
   * Elimina artifact (metadata + storage file si backend tiene service role key).
   */
  function artifactDelete(id) {
    if (!id || !backendIsEnabled()) return Promise.resolve({ ok: false });
    return backendApiRequest('/api/v1/artifacts/' + id, { method: 'DELETE' }).then(function () {
      return { ok: true };
    }).catch(function () {
      return { ok: false };
    });
  }

  /**
   * Helper completo: sube archivo a Supabase Storage + registra metadata en backend.
   * Uso:
   *   artifactUpload('mbz_final', mbzBlob, 'curso_final.mbz', 'application/octet-stream', { validationOk: true })
   *
   * @param {string} type          — content_snapshot | audio_welcome | audiobook | h5p_snapshot | mbz_final | diagnostic
   * @param {Blob|string} content  — Blob para archivos binarios, string/object para JSON (se convierte a Blob)
   * @param {string} filename      — nombre del archivo
   * @param {string} [mimeType]    — MIME type (default: detectado del tipo)
   * @param {object} [metadata]    — metadata adicional para el registro
   * @param {{ storageFolder?: string, storagePath?: string, storageBucket?: string, storageProvider?: string, checksumSha256?: string }} [options]
   * @returns {Promise<{ok, artifactId?, storagePath?, bucket?, error?}>}
   */
  function artifactUpload(type, content, filename, mimeType, metadata, options) {
    if (!window.SB || !window.SB_USER) {
      return Promise.resolve({ ok: false, error: 'no_auth' });
    }
    if (!backendIsEnabled()) {
      return Promise.resolve({ ok: false, error: 'backend_off' });
    }

    options = options || {};

    var userId   = window.SB_USER.id;
    var courseId = window.ACTIVE_COURSE_ID || 'unknown';
    var jobId    = (window.COURSE_PRODUCTION && window.COURSE_PRODUCTION._backendJobId) || null;
    var ts       = Date.now();

    // Build storage path: {user_id}/{course_id}/{type}/{filename}
    var safeName = (filename || (type + '_' + ts)).replace(/[^a-zA-Z0-9._-]/g, '_');
    var bucket   = options.storageBucket || 'cursia-artifacts';
    var provider = options.storageProvider || 'supabase';
    var folder   = String(options.storageFolder || type).replace(/^\/+|\/+$/g, '') || type;
    var storagePath = options.storagePath
      ? String(options.storagePath).replace(/^\/+/, '')
      : (userId + '/' + courseId + '/' + folder + '/' + safeName);

    // Convert content to Blob if needed
    var blob;
    var detectedMime = mimeType;
    if (content instanceof Blob) {
      blob = content;
      if (!detectedMime) detectedMime = content.type || 'application/octet-stream';
    } else if (typeof content === 'string') {
      blob = new Blob([content], { type: 'application/json' });
      if (!detectedMime) detectedMime = 'application/json';
    } else if (content && typeof content === 'object') {
      blob = new Blob([JSON.stringify(content)], { type: 'application/json' });
      if (!detectedMime) detectedMime = 'application/json';
    } else {
      return Promise.resolve({ ok: false, error: 'invalid_content' });
    }

    // 1. Upload to Supabase Storage
    return window.SB.storage
      .from(bucket)
      .upload(storagePath, blob, { upsert: true, contentType: detectedMime })
      .then(function (uploadRes) {
        if (uploadRes.error) {
          console.warn('[Cursia:artifacts] Storage upload failed:', uploadRes.error.message);
          return { ok: false, error: 'storage_upload_failed: ' + uploadRes.error.message };
        }

        // 2. Register metadata in backend
        return artifactCreate({
          course_id:    courseId,
          job_id:       jobId,
          type:         type,
          storage_provider: provider,
          storage_bucket: bucket,
          storage_path: storagePath,
          filename:     filename || safeName,
          mime_type:    detectedMime,
          size_bytes:   blob.size || 0,
          checksum_sha256: options.checksumSha256 || null,
          metadata:     metadata || {}
        }).then(function (regRes) {
          var artifactId = (regRes.ok && regRes.data && regRes.data.id) ? regRes.data.id : null;
          return { ok: true, artifactId: artifactId, storagePath: storagePath, bucket: bucket };
        });
      })
      .catch(function (e) {
        console.warn('[Cursia:artifacts] Upload error:', e.message || e);
        return { ok: false, error: e.message || 'upload_error' };
      });
  }

  // ──────────────────────────────────────────────────────────────
  // P2.1 — Backend Content Generation (frontend trigger + polling)
  //
  // startBackendContentGeneration() → crea job backend_content vía
  //   POST /api/v1/jobs/content usando D actual.
  // pollBackendContentJob(jobId) → polling periódico con callback.
  // getBackendContentJobStatus(courseId) → lee último job del curso.
  // ──────────────────────────────────────────────────────────────

  /**
   * Construye el payload para POST /api/v1/jobs/content desde D actual.
   * @returns {{ courseId, frontendJobId, contentConfig, courseData, options, metadata }}
   */
  function _buildContentJobPayload() {
    var d = window.D || {};
    var courseId = window.ACTIVE_COURSE_ID || d.id || d.courseId || ('content-' + Date.now());

    var mods = [];
    if (Array.isArray(d.mods)) {
      d.mods.forEach(function (m) {
        mods.push({
          n: m.n || 'Módulo',
          caps: Array.isArray(m.caps)
            ? m.caps.map(function (c) { return typeof c === 'string' ? c : (c && c.t) || 'Capítulo'; })
            : []
        });
      });
    }

    return {
      courseId: String(courseId),
      frontendJobId: 'fe-content-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8),
      contentConfig: {
        model: 'claude-sonnet-4-6',
        maxRetriesPerFile: 3
      },
      courseData: {
        nombre: d.nombre || 'Curso Virtual',
        comp:   d.comp   || '',
        pais:   d.pais   || 'Colombia',
        ciudad: d.ciudad || '',
        sector: d.sector || 'General',
        mid:    d.mid    || 'XX',
        lms:    d.lms    || '',
        nivel:  d.nivel  || 'intermedio',
        tono:   d.tono   || 'formal',
        contexto: d.contexto || 'profesional',
        obj:    d.obj    || '',
        horas:  d.horas  || 80,
        mods:   mods
      },
      options: {
        overwriteExistingContent: false
      },
      metadata: {
        source: 'frontend-trigger',
        triggeredAt: new Date().toISOString()
      }
    };
  }

  /**
   * Inicia generación de contenido en backend.
   * Crea un job backend_content vía POST /api/v1/jobs/content.
   *
   * @returns {Promise<{ok, jobId?, error?}>}
   */
  function startBackendContentGeneration() {
    if (!backendIsEnabled()) {
      console.warn('[Cursia:content-worker] Backend no habilitado');
      return Promise.resolve({ ok: false, error: 'backend_disabled', userMsg: 'Backend no habilitado. Activa la conexión al servidor primero.' });
    }
    if (!window.SB_USER) {
      console.warn('[Cursia:content-worker] No hay usuario autenticado');
      return Promise.resolve({ ok: false, error: 'not_authenticated', userMsg: 'Inicia sesión para usar la generación en nube.' });
    }

    // Asegurar que D está actualizado
    if (typeof collect === 'function') {
      try { collect(); } catch (e) {}
    }

    var d = window.D || {};
    if (!d.nombre && !d.mods) {
      console.warn('[Cursia:content-worker] No hay datos de curso (D). Configura el curso primero.');
      return Promise.resolve({ ok: false, error: 'no_course_data', userMsg: 'No hay datos de curso. Configura el curso primero.' });
    }

    var payload = _buildContentJobPayload();
    var courseId = payload.courseId;

    // ── P2.1-C7: Prevenir jobs duplicados ──
    // Primero verificar si ya existe un job activo para este curso
    return getBackendContentJobStatus(courseId).then(function (statusRes) {
      if (statusRes.ok && statusRes.job) {
        var ws = _jobField(statusRes.job, 'worker_status', 'workerStatus')
              || _jobField(statusRes.job, 'status', 'status')
              || '';
        var ACTIVE_STATUSES = ['queued', 'running', 'retrying'];
        if (ACTIVE_STATUSES.indexOf(ws) !== -1) {
          console.warn('[Cursia:content-worker] Ya existe un job activo para', courseId, '— estado:', ws, '— id:', statusRes.job.id);
          return {
            ok: false,
            error: 'duplicate_active_job',
            userMsg: 'Ya existe una generación de contenido en nube activa para este curso (estado: ' + ws + ').\n\nEspera a que termine antes de crear una nueva.',
            existingJobId: statusRes.job.id,
            existingStatus: ws
          };
        }
      }

      // No hay job activo, crear uno nuevo
      console.log('[Cursia:content-worker] Creando job backend_content para:', courseId);

      return backendApiRequest('/api/v1/jobs/content', {
        method: 'POST',
        body: payload
      }).then(function (res) {
        if (!res.ok) {
          console.error('[Cursia:content-worker] Error creando job:', res.error);
          return { ok: false, error: res.error || 'create_failed', userMsg: 'Error al crear el job en el servidor: ' + (res.error || 'desconocido') };
        }
        var data = res.data || {};
        var job = data.data || data;
        var jobId = job.id || job.jobId || null;

        if (!jobId) {
          console.error('[Cursia:content-worker] Job creado pero sin ID');
          return { ok: false, error: 'no_job_id', userMsg: 'El servidor respondió pero no devolvió un ID de job.' };
        }

        console.log('[Cursia:content-worker] Job creado:', jobId);
        return { ok: true, jobId: jobId, job: job };
      });
    }).catch(function (e) {
      console.error('[Cursia:content-worker] Error inesperado:', e.message);
      return { ok: false, error: e.message, userMsg: 'Error inesperado: ' + e.message };
    });
  }

  /**
   * Lee el estado del último job backend_content para un curso.
   * Busca en jobList filtrando por courseId y execution_mode.
   *
   * @param {string} [courseId] — Si no se pasa, usa ACTIVE_COURSE_ID.
   * @returns {Promise<{ok, job?, error?}>}
   */
  /**
   * Helper: lee un campo de un job tolerando snake_case y camelCase.
   */
  function _jobField(job, snakeName, camelName) {
    if (job[snakeName] !== undefined) return job[snakeName];
    if (job[camelName] !== undefined) return job[camelName];
    return undefined;
  }

  function getBackendContentJobStatus(courseId) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId) return Promise.resolve({ ok: false, error: 'no_course_id' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });

    return jobList(courseId).then(function (res) {
      if (!res.ok || !res.data || !res.data.length) {
        console.log('[Cursia:content-worker] getBackendContentJobStatus: no jobs for', courseId, '— res.ok:', res.ok, 'count:', (res.data || []).length);
        return { ok: false, error: 'no_jobs_found' };
      }

      var allJobs = res.data;
      console.log('[Cursia:content-worker] getBackendContentJobStatus: found', allJobs.length, 'total jobs for', courseId);

      // Log field names of first job for diagnostics
      if (allJobs[0]) {
        console.log('[Cursia:content-worker] Sample job fields:', Object.keys(allJobs[0]).join(', '));
      }

      // Filtrar jobs backend_content — tolerar snake_case y camelCase
      var contentJobs = allJobs.filter(function (j) {
        var execMode = _jobField(j, 'execution_mode', 'executionMode');
        return execMode === 'backend_content';
      });

      console.log('[Cursia:content-worker] backend_content jobs:', contentJobs.length);

      // Fallback: si no hay execution_mode, considerar jobs que tengan
      // worker_status/workerStatus (solo backend_content jobs lo tienen)
      if (!contentJobs.length) {
        contentJobs = allJobs.filter(function (j) {
          var ws = _jobField(j, 'worker_status', 'workerStatus');
          return ws !== undefined && ws !== null;
        });
        if (contentJobs.length) {
          console.log('[Cursia:content-worker] Fallback: found', contentJobs.length, 'jobs with worker_status');
        }
      }

      if (!contentJobs.length) {
        console.log('[Cursia:content-worker] No backend_content jobs found');
        return { ok: false, error: 'no_content_jobs' };
      }

      // Ordenar por fecha desc — tolerar ambos formatos
      contentJobs.sort(function (a, b) {
        var dateA = new Date(_jobField(a, 'created_at', 'createdAt') || 0);
        var dateB = new Date(_jobField(b, 'created_at', 'createdAt') || 0);
        return dateB - dateA;
      });

      var latest = contentJobs[0];
      var latestWs = _jobField(latest, 'worker_status', 'workerStatus') || _jobField(latest, 'status', 'status') || '';
      console.log('[Cursia:content-worker] Latest backend_content job:', latest.id, 'status:', latestWs);

      return { ok: true, job: latest };
    }).catch(function (e) {
      console.error('[Cursia:content-worker] getBackendContentJobStatus error:', e.message);
      return { ok: false, error: e.message };
    });
  }

  /**
   * Polling periódico del estado de un job backend_content.
   * Llama al callback con el estado actual cada intervalMs.
   * Se detiene cuando el job llega a completed/failed/failed_recoverable
   * o cuando se invoca la función stop() retornada.
   *
   * @param {string} jobId
   * @param {function} onUpdate — fn({ job, workerStatus, progress, done, error? })
   * @param {number} [intervalMs=5000]
   * @returns {{ stop: function }}
   */
  function pollBackendContentJob(jobId, onUpdate, intervalMs) {
    if (!jobId || typeof onUpdate !== 'function') {
      console.warn('[Cursia:content-worker] pollBackendContentJob: faltan jobId u onUpdate');
      return { stop: function () {} };
    }
    intervalMs = intervalMs || 5000;
    var MAX_CONSECUTIVE_ERRORS = 10;
    var stopped = false;
    var timer = null;
    var consecutiveErrors = 0;

    function _poll() {
      if (stopped) return;
      jobGet(jobId).then(function (res) {
        if (stopped) return;
        if (!res || !res.ok) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.error('[Cursia:content-worker] Polling detenido tras', MAX_CONSECUTIVE_ERRORS, 'errores consecutivos para job:', jobId);
            onUpdate({ job: null, workerStatus: 'unknown', progress: 0, done: true, error: 'polling_stopped_max_errors' });
            stopped = true;
            return;
          }
          onUpdate({ job: null, workerStatus: 'unknown', progress: 0, done: false, error: 'poll_failed' });
          _schedule();
          return;
        }
        consecutiveErrors = 0; // Reset on success
        var raw = res.data || {};
        var job = raw.data || raw;
        var ws = _jobField(job, 'worker_status', 'workerStatus')
              || _jobField(job, 'status', 'status')
              || 'unknown';
        var progress = job.progress || 0;
        var done = (ws === 'completed' || ws === 'failed' || ws === 'failed_recoverable');

        onUpdate({
          job: job,
          workerStatus: ws,
          progress: progress,
          done: done,
          contentSnapshotArtifactId: _jobField(job, 'content_snapshot_artifact_id', 'contentSnapshotArtifactId') || null,
          outputSummary: _jobField(job, 'output_summary', 'outputSummary') || null
        });

        if (!done) _schedule();
      }).catch(function (e) {
        if (stopped) return;
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error('[Cursia:content-worker] Polling detenido tras', MAX_CONSECUTIVE_ERRORS, 'errores consecutivos para job:', jobId);
          onUpdate({ job: null, workerStatus: 'unknown', progress: 0, done: true, error: 'polling_stopped_max_errors' });
          stopped = true;
          return;
        }
        onUpdate({ job: null, workerStatus: 'unknown', progress: 0, done: false, error: e.message });
        _schedule();
      });
    }

    function _schedule() {
      if (stopped) return;
      timer = setTimeout(_poll, intervalMs);
    }

    // Arrancar inmediatamente
    _poll();

    return {
      stop: function () {
        stopped = true;
        if (timer) { clearTimeout(timer); timer = null; }
      }
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Exponer funciones como globales
  // ──────────────────────────────────────────────────────────────
  window.backendConfigure              = backendConfigure;
  window.backendIsEnabled              = backendIsEnabled;
  window.backendGetBaseUrl             = backendGetBaseUrl;
  window.backendSetBaseUrl             = backendSetBaseUrl;
  window.backendHealthCheck            = backendHealthCheck;
  window.backendApiRequest             = backendApiRequest;
  window.backendCreateCourse           = backendCreateCourse;
  window.backendCreateCourseVersion    = backendCreateCourseVersion;
  window.backendListCourses            = backendListCourses;
  window.backendGetCourse              = backendGetCourse;
  // Fase 2 — Editor de estructura dinámica (staging only)
  window.backendCreateDynamicCourse    = backendCreateDynamicCourse;
  window.backendGetCourseStructure     = backendGetCourseStructure;
  window.backendCreateModule           = backendCreateModule;
  window.backendUpdateModule           = backendUpdateModule;
  window.backendDeleteModule           = backendDeleteModule;
  window.backendReorderModules         = backendReorderModules;
  window.backendCreateChapter          = backendCreateChapter;
  window.backendUpdateChapter          = backendUpdateChapter;
  window.backendUpdateStructureSettings = backendUpdateStructureSettings;
  window.backendGetCourseProfile = backendGetCourseProfile;
  window.backendPedagogyCatalog = backendPedagogyCatalog;
  window.backendPedagogyWizard = backendPedagogyWizard;
  window.backendPedagogyRecommend = backendPedagogyRecommend;
  window.backendPedagogyCourseDryRun = backendPedagogyCourseDryRun;
  window.backendApplyDistribution = backendApplyDistribution;
  window.backendApplyAcademicStructure = backendApplyAcademicStructure;
  window.backendRecordStructureOrigin = backendRecordStructureOrigin;
  window.backendGetBrief = backendGetBrief;
  window.backendPutBrief = backendPutBrief;
  window.backendGetFacts = backendGetFacts;
  window.backendGetDocumentRequirements = backendGetDocumentRequirements;
  window.backendSetRequirementSelection = backendSetRequirementSelection;
  window.backendSaveRequirementDecisions = backendSaveRequirementDecisions;
  window.backendExtractAdvanced = backendExtractAdvanced;
  window.backendUseDocumentInPedagogy = backendUseDocumentInPedagogy;
  window.backendExtractAcademicContext = backendExtractAcademicContext;
  window.backendSaveAcademicProposal = backendSaveAcademicProposal;
  window.backendSaveAcademicOutcomes = backendSaveAcademicOutcomes;
  window.backendDesignRecommendation = backendDesignRecommendation;
  window.backendPrebriefState = backendPrebriefState;
  window.backendPrebriefPrepare = backendPrebriefPrepare;
  window.backendPrebriefApprove = backendPrebriefApprove;
  window.backendPrebriefRequestChanges = backendPrebriefRequestChanges;
  window.backendPrebriefWithdraw = backendPrebriefWithdraw;
  window.backendPrebriefExceptionReason = backendPrebriefExceptionReason;
  window.backendPrebriefConfirm = backendPrebriefConfirm;
  window.backendCourseFormat = backendCourseFormat;
  window.backendStructureOptions = backendStructureOptions;
  window.backendStructurePreview = backendStructurePreview;
  window.backendGetCourseFormat = backendGetCourseFormat;
  window.backendPrebriefPdf = backendPrebriefPdf;
  window.backendClearDesignPins = backendClearDesignPins;
  window.backendDesignFix = backendDesignFix;
  window.backendRecordDesignHours = backendRecordDesignHours;
  window.backendGetAcademicDesign = backendGetAcademicDesign;
  window.backendChangeImpact = backendChangeImpact;
  window.backendSaveCourseProfile = backendSaveCourseProfile;
  window.backendDeleteChapter          = backendDeleteChapter;
  window.backendReorderChapters        = backendReorderChapters;
  window.backendMoveChapter            = backendMoveChapter;
  window.backendListCourseVersions     = backendListCourseVersions;
  // Fase 3 — Blueprints (staging only)
  window.backendCreateBlueprint        = backendCreateBlueprint;
  window.backendListBlueprints         = backendListBlueprints;
  window.backendGetCurrentBlueprint    = backendGetCurrentBlueprint;
  window.backendGetBlueprint           = backendGetBlueprint;
  window.backendGetManifest            = backendGetManifest;
  window.backendCreateManifest         = backendCreateManifest;
  window.backendGetFeatures            = backendGetFeatures;
  // Fase 5A Task 6a — Generación dynamic (runs + ejecutor del navegador)
  window.backendDynStartRun            = backendDynStartRun;
  window.backendDynGetCurrentRun       = backendDynGetCurrentRun;
  window.backendDynEstimate            = backendDynEstimate;
  window.backendDynPreviewStart        = backendDynPreviewStart;
  window.backendDynApproveAndStart     = backendDynApproveAndStart;
  window.backendDynGetRun              = backendDynGetRun;
  window.backendDynCancelRun           = backendDynCancelRun;
  window.backendDynPauseRun            = backendDynPauseRun;
  window.backendDynResumeRun           = backendDynResumeRun;
  window.backendDynRetryItem           = backendDynRetryItem;
  window.backendDynReconcileVideogenReservation = backendDynReconcileVideogenReservation;
  window.backendDynClaim               = backendDynClaim;
  window.backendDynDeviceExecutorId    = backendDynDeviceExecutorId;
  window.backendDynReleaseLease        = backendDynReleaseLease;
  window.backendDynHeartbeat           = backendDynHeartbeat;
  window.backendDynComplete            = backendDynComplete;
  window.backendDynFail                = backendDynFail;
  window.backendDynPackage             = backendDynPackage;
  window.backendDynGetPackage          = backendDynGetPackage;
  window.backendDynAdminNeedsAttention = backendDynAdminNeedsAttention;
  // Fase 7/8 (F78-FE) — coherencia e invalidación
  window.backendCoherenceStructure          = backendCoherenceStructure;
  window.backendCoherenceGetRunReport       = backendCoherenceGetRunReport;
  window.backendCoherenceComputeRunReport   = backendCoherenceComputeRunReport;
  window.backendCoherenceUploadLlmFindings  = backendCoherenceUploadLlmFindings;
  window.backendDynInvalidationPlan         = backendDynInvalidationPlan;
  window.backendDynRegenerateItem           = backendDynRegenerateItem;
  window.backendDynRegenerateDryRun         = backendDynRegenerateDryRun;
  window.backendDynVideoUpgradePreview      = backendDynVideoUpgradePreview;
  window.backendDynVideoUpgrade             = backendDynVideoUpgrade;
  window.backendCoherenceGetLlmInput        = backendCoherenceGetLlmInput;
  // DN-1 — YouTube (preflight de solo lectura + conexión OAuth legacy)
  window.backendDynYoutubePreflight         = backendDynYoutubePreflight;
  window.backendYoutubeOAuthSession         = backendYoutubeOAuthSession;
  window.backendYoutubeConnection           = backendYoutubeConnection;
  window.backendDynYoutubeResolution        = backendDynYoutubeResolution;
  window.dynArtifactUpload             = dynArtifactUpload;
  window.enableBackendCloud            = enableBackendCloud;
  window.disableBackendCloud           = disableBackendCloud;
  window.backendSaveCloudCopy          = backendSaveCloudCopy;
  window.backendBuildSnapshot          = backendBuildSnapshot;
  window.backendEstimateSnapshotSize   = backendEstimateSnapshotSize;
  window._renderBackendPanel           = _renderBackendPanel;
  window._backendTestConnection        = _backendTestConnection;
  window._updateBackendSidebarBadge    = _updateBackendSidebarBadge;
  window.backendRefreshCloudCourses    = backendRefreshCloudCourses;
  window.backendToggleCourseVersions   = backendToggleCourseVersions;
  window.backendRenderCourseCard       = backendRenderCourseCard;
  window.backendFormatDate             = backendFormatDate;
  // Fase 5.2 — Restore desde nube
  window.backendGetCourseVersion         = backendGetCourseVersion;
  window.backendGetCourseCost            = backendGetCourseCost;
  window.backendLoadSnapshotFromVersion  = backendLoadSnapshotFromVersion;
  window.backendValidateSnapshot         = backendValidateSnapshot;
  window.backendCreateLocalRestoreBackup = backendCreateLocalRestoreBackup;
  window.backendRestoreSnapshot          = backendRestoreSnapshot;
  window.validateContentSnapshot         = validateContentSnapshot;
  window.getLatestContentSnapshotArtifact = getLatestContentSnapshotArtifact;
  window.openContentSnapshotArtifact     = openContentSnapshotArtifact;
  window.openArtifactJsonById            = openArtifactJsonById;
  window.getLatestArtifactId             = getLatestArtifactId;
  window.restoreContentSnapshotFromCloud = restoreContentSnapshotFromCloud;
  window.backendRestoreCourseVersion     = backendRestoreCourseVersion;
  // Fase 5.2 — Backup local UI
  window.backendGetLocalRestoreBackup    = backendGetLocalRestoreBackup;
  window.backendRestoreLocalBackup       = backendRestoreLocalBackup;
  // Diagnóstico — request log (usar desde consola: _getRequestLog())
  window._getRequestLog                  = _getRequestLog;
  window._classifyFetchError             = _classifyFetchError;
  // ──────────────────────────────────────────────────────────────
  // Fase 6 — Full Course Orchestrator Job
  // Crea o recupera un job maestro course_full_generation.
  // Lo distingue de otros jobs por options.executionMode.
  // ──────────────────────────────────────────────────────────────

  /**
   * Crea o reutiliza un job maestro course_full_generation para el curso.
   * Almacena el tipo en options.executionMode para distinción en la library.
   * Deduplicación: si ya hay uno activo, lo devuelve sin crear uno nuevo.
   *
   * @param {string} [courseId]
   * @param {string} [cpJobId] — ID del job local (CP.jobId)
   * @returns {Promise<{ok, jobId?, resumed?, error?}>}
   */
  function createFullCourseJob(courseId, cpJobId) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId || !backendIsEnabled() || !window.SB_USER) {
      return Promise.resolve({ ok: false, error: 'unavailable' });
    }

    var ACTIVE_STATUSES = ['running', 'queued', 'retrying'];

    return jobList(courseId).then(function (listRes) {
      // Check for existing active full course job
      if (listRes.ok && Array.isArray(listRes.data)) {
        var existingJob = null;
        for (var i = 0; i < listRes.data.length; i++) {
          var j = listRes.data[i];
          var execMode = (j.options && j.options.executionMode)
                      || j.execution_mode || j.executionMode || '';
          var status   = j.status || '';
          if (execMode === 'course_full_generation' && ACTIVE_STATUSES.indexOf(status) !== -1) {
            existingJob = j;
            break;
          }
        }
        if (existingJob) {
          console.log('[Cursia:full-course-job] Job activo encontrado:', existingJob.id);
          return { ok: true, jobId: existingJob.id, resumed: true };
        }
      }

      // No existing active job — create new
      console.log('[Cursia:full-course-job] Creando job maestro para:', courseId);
      return jobCreate(courseId, cpJobId || ('full-' + Date.now()), {
        executionMode: 'course_full_generation',
        source:        'frontend',
        createdAt:     new Date().toISOString()
      }).then(function (res) {
        if (res.ok) {
          console.log('[Cursia:full-course-job] Job maestro creado:', res.jobId);
        }
        return res;
      });
    }).catch(function (e) {
      console.warn('[Cursia:full-course-job] Error:', e && e.message);
      return { ok: false, error: e && e.message || 'unknown' };
    });
  }

  /**
   * Busca el job maestro course_full_generation activo más reciente para el curso.
   * Devuelve {ok, job?} — útil para recovery tras reload.
   */
  function getFullCourseJobStatus(courseId) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId || !backendIsEnabled() || !window.SB_USER) {
      return Promise.resolve({ ok: false, error: 'unavailable' });
    }

    return jobList(courseId).then(function (listRes) {
      if (!listRes.ok || !Array.isArray(listRes.data) || !listRes.data.length) {
        return { ok: false, error: 'no_jobs' };
      }

      // Filter full course jobs
      var fullJobs = listRes.data.filter(function (j) {
        var execMode = (j.options && j.options.executionMode)
                    || j.execution_mode || j.executionMode || '';
        return execMode === 'course_full_generation';
      });

      if (!fullJobs.length) return { ok: false, error: 'no_full_course_jobs' };

      // Return most recent
      fullJobs.sort(function (a, b) {
        return new Date(b.created_at || b.createdAt || 0)
             - new Date(a.created_at || a.createdAt || 0);
      });

      return { ok: true, job: fullJobs[0] };
    }).catch(function (e) {
      return { ok: false, error: e && e.message || 'unknown' };
    });
  }

  // P0 SaaS — Production Jobs
  window.jobCreate                       = jobCreate;
  window.jobUpdate                       = jobUpdate;
  window.jobGet                          = jobGet;
  window.jobReportStep                   = jobReportStep;
  window.jobList                         = jobList;
  window.jobSyncCourseState              = jobSyncCourseState;
  // Fase 6
  window.createFullCourseJob             = createFullCourseJob;
  window.getFullCourseJobStatus          = getFullCourseJobStatus;
  // P1.0 SaaS — Artifacts
  window.artifactCreate                  = artifactCreate;
  window.artifactList                    = artifactList;
  window.artifactGet                     = artifactGet;
  window.artifactDownloadUrl             = artifactDownloadUrl;
  window.artifactDelete                  = artifactDelete;
  window.artifactUpload                  = artifactUpload;
  // P2.1 SaaS — Backend Content Generation
  window.startBackendContentGeneration   = startBackendContentGeneration;
  window.pollBackendContentJob           = pollBackendContentJob;
  window.getBackendContentJobStatus      = getBackendContentJobStatus;

  // ──────────────────────────────────────────────────────────────
  // Backend Videos — P2.2 / P2.3
  // createBackendVideoJob, getBackendVideoJobStatus,
  // restoreBackendVideoResultsFromJob, restoreBackendVideoResultsFromCloud
  // ──────────────────────────────────────────────────────────────

  /**
   * Crea un job backend_videos en el servidor.
   * POST /api/v1/jobs/videos
   *
   * @param {string} courseId
   * @param {{ courseData, videoConfig?, options?, metadata? }} payload
   * @returns {Promise<{ok, jobId?, job?, error?, userMsg?}>}
   */
  function createBackendVideoJob(courseId, payload) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId) return Promise.resolve({ ok: false, error: 'no_course_id', userMsg: 'Falta courseId.' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });

    var body = Object.assign({
      courseId: courseId,
      executionMode: 'backend_videos',
    }, payload || {});

    return backendApiRequest('/api/v1/jobs/videos', { method: 'POST', body: body })
      .then(function (res) {
        if (!res.ok) {
          var errMsg = (res.data && res.data.message) || res.error || 'create_failed';
          return { ok: false, error: errMsg, userMsg: 'Error creando job de video: ' + errMsg };
        }
        var data = res.data || {};
        var job = data.data || data;
        var jobId = job.jobId || job.id || null;
        console.log('[Cursia:video-worker] Job backend_videos creado:', jobId);
        return { ok: true, jobId: jobId, job: job };
      })
      .catch(function (e) {
        return { ok: false, error: e.message, userMsg: 'Error inesperado: ' + e.message };
      });
  }

  /**
   * Obtiene el último job backend_videos para un curso.
   *
   * @param {string} [courseId]
   * @returns {Promise<{ok, job?, error?}>}
   */
  function getBackendVideoJobStatus(courseId) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId) return Promise.resolve({ ok: false, error: 'no_course_id' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });

    return jobList(courseId).then(function (res) {
      if (!res.ok || !res.data || !res.data.length) {
        return { ok: false, error: 'no_jobs_found' };
      }

      var videoJobs = res.data.filter(function (j) {
        var execMode = _jobField(j, 'execution_mode', 'executionMode');
        return execMode === 'backend_videos';
      });

      if (!videoJobs.length) {
        return { ok: false, error: 'no_video_jobs' };
      }

      videoJobs.sort(function (a, b) {
        var dateA = new Date(_jobField(a, 'created_at', 'createdAt') || 0);
        var dateB = new Date(_jobField(b, 'created_at', 'createdAt') || 0);
        return dateB - dateA;
      });

      var latest = videoJobs[0];
      console.log('[Cursia:video-worker] Latest backend_videos job:', latest.id,
        'workerStatus:', _jobField(latest, 'worker_status', 'workerStatus'),
        'phase:', ((_jobField(latest, 'output_summary', 'outputSummary') || {}).phase));
      return { ok: true, job: latest };
    }).catch(function (e) {
      return { ok: false, error: e.message };
    });
  }

  /**
   * Restaura los resultados de un job backend_videos a MEDIA.videos /
   * VIDEO_ENGINE.jobs sin descargar ningún blob ni tocar H5P/MBZ.
   *
   * Lógica por capítulo:
   *   - Si hay youtubeUrl (uploaded) → saveYoutubeUrlForChapter → MEDIA.videos
   *   - Si hay solo downloadUrl (videogen_completed sin YouTube) → VIDEO_ENGINE.jobs
   *   - En ambos casos rellena MEDIA.videoTranscripts con el título como placeholder
   *
   * @param {Object} job — job object con output_summary
   * @returns {{ ok, restoredYoutube, restoredDownload, skipped, caps }}
   */
  function _setYoutubeRecoveryStateFromCloud(summary, ytUploads, capData) {
    var phase = summary && summary.phase || null;
    var pendingCaps = Object.keys(capData || {}).map(function (capStr) {
      var item = capData[capStr];
      return item && !item.youtubeUrl && item.downloadUrl ? parseInt(capStr, 10) : null;
    }).filter(function (cap) { return !!cap; }).sort(function (a, b) { return a - b; });

    if (typeof window.videoEngineSetYoutubeRecoveryState !== 'function') return;

    if (!pendingCaps.length && phase === 'youtube_completed') {
      window.videoEngineSetYoutubeRecoveryState('ready', [], null, { youtube_block_reason: null });
      return;
    }

    if (phase === 'blocked_auth') {
      window.videoEngineSetYoutubeRecoveryState('needs_reconnect', pendingCaps, 'Necesita reconectar YouTube para continuar.', {
        youtube_block_reason: 'auth',
      });
      return;
    }

    if (phase === 'blocked_quota') {
      window.videoEngineSetYoutubeRecoveryState('quota_blocked', pendingCaps, 'YouTube no permitió subir más videos por ahora. Puedes intentarlo más tarde.', {
        youtube_block_reason: 'quota',
      });
      return;
    }

    if (pendingCaps.length > 0) {
      window.videoEngineSetYoutubeRecoveryState('pending_retry', pendingCaps, 'No pudimos subir algunos videos. Puedes reintentar.', {
        youtube_block_reason: null,
      });
      return;
    }

    window.videoEngineSetYoutubeRecoveryState('idle', [], null, { youtube_block_reason: null });
  }

  function restoreBackendVideoResultsFromJob(job) {
    if (!job) return { ok: false, error: 'no_job' };

    var summary    = _jobField(job, 'output_summary', 'outputSummary') || {};
    var vgJobs     = Array.isArray(summary.videogenJobs)   ? summary.videogenJobs   : [];
    var ytUploads  = Array.isArray(summary.youtubeUploads) ? summary.youtubeUploads : [];

    // Merge by cap number
    var capData = {};

    vgJobs.forEach(function (vj) {
      var cap = vj.cap || vj.chapter_number;
      if (!cap) return;
      cap = parseInt(cap, 10);
      capData[cap] = {
        cap:         cap,
        title:       vj.title  || null,
        downloadUrl: vj.downloadUrl || vj.download_url || null,
        youtubeUrl:  null,
        uploadStatus: null,
        uploadError: null,
        uploadErrorType: null,
      };
    });

    ytUploads.forEach(function (yu) {
      var cap = parseInt(yu.cap || 0, 10);
      if (!cap) return;
      if (!capData[cap]) {
        capData[cap] = {
          cap: cap,
          title: yu.title || null,
          downloadUrl: yu.downloadUrl || yu.download_url || null,
          youtubeUrl: null,
          uploadStatus: null,
          uploadError: null,
          uploadErrorType: null,
        };
      }
      capData[cap].uploadStatus = yu.status || capData[cap].uploadStatus || null;
      capData[cap].uploadError = yu.error || capData[cap].uploadError || null;
      capData[cap].uploadErrorType = yu.errorType || yu.reason || capData[cap].uploadErrorType || null;
      if (!capData[cap].downloadUrl && (yu.downloadUrl || yu.download_url)) {
        capData[cap].downloadUrl = yu.downloadUrl || yu.download_url;
      }
      if (yu.status === 'uploaded' && yu.youtubeUrl) {
        capData[cap].youtubeUrl = yu.youtubeUrl;
      }
    });

    var restoredYoutube  = 0;
    var restoredDownload = 0;
    var skipped          = 0;

    Object.keys(capData).forEach(function (capStr) {
      var d   = capData[capStr];
      var cap = parseInt(capStr, 10);

      if (d.youtubeUrl) {
        // ── YouTube URL present: use the existing helper ─────────────────
        if (typeof saveYoutubeUrlForChapter === 'function') {
          saveYoutubeUrlForChapter(cap, d.youtubeUrl, {
            source:              'backend_videos_restore',
            uploaded_to_youtube: true,
          });
        } else {
          // Fallback if helper not yet loaded
          if (!window.MEDIA) window.MEDIA = { audio: null, audiolibro: null, videos: {}, videoTranscripts: {} };
          window.MEDIA.videos['v' + cap] = d.youtubeUrl;
          console.log('[Cursia:video-restore] Cap ' + cap + ' → MEDIA.videos[v' + cap + '] (fallback)');
        }
        restoredYoutube++;

      } else if (d.downloadUrl) {
        // ── Only downloadUrl (Videogen, no YouTube yet) ──────────────────
        if (!window.VIDEO_ENGINE)       window.VIDEO_ENGINE = {};
        if (!window.VIDEO_ENGINE.jobs)  window.VIDEO_ENGINE.jobs = {};
        var existing = window.VIDEO_ENGINE.jobs[cap] || {};
        var youtubePhase = d.uploadStatus === 'auth_required' || d.uploadStatus === 'reauth_required'
          ? 'needs_reconnect'
          : d.uploadStatus === 'quota_exceeded'
          ? 'quota_blocked'
          : d.uploadStatus === 'failed'
          ? 'youtube_failed'
          : 'youtube_pending';
        window.VIDEO_ENGINE.jobs[cap] = Object.assign({}, existing, {
          chapter_num:  cap,
          job_id:       existing.job_id || null,
          status:       'completed_local',
          download_url: d.downloadUrl,
          title:        d.title || existing.title || null,
          youtube_phase: youtubePhase,
          youtube_error: d.uploadError || null,
          error:        d.uploadError || existing.error || null,
          errorType:    d.uploadErrorType || existing.errorType || null,
          recoverable:  youtubePhase !== 'quota_blocked' && youtubePhase !== 'needs_reconnect',
          source:       'backend_videos_restore',
          updated_at:   new Date().toISOString(),
          created_at:   existing.created_at || new Date().toISOString(),
        });
        if (typeof videoEngineSaveState === 'function') videoEngineSaveState();
        restoredDownload++;

      } else {
        skipped++;
      }

      // ── Rellena MEDIA.videoTranscripts con título placeholder ─────────
      if (d.title) {
        if (!window.MEDIA) window.MEDIA = { audio: null, audiolibro: null, videos: {}, videoTranscripts: {} };
        if (!window.MEDIA.videoTranscripts) window.MEDIA.videoTranscripts = {};
        if (!window.MEDIA.videoTranscripts['v' + cap]) {
          window.MEDIA.videoTranscripts['v' + cap] = {
            source: 'backend_videos_restore',
            title:  d.title,
            text:   null,
          };
        }
      }
    });

    var caps = Object.keys(capData).length;
    _setYoutubeRecoveryStateFromCloud(summary, ytUploads, capData);
    console.log('[Cursia:video-restore] Restaurados: ' + restoredYoutube +
      ' YouTube URLs, ' + restoredDownload + ' downloadUrls, ' + skipped +
      ' saltados, ' + caps + ' caps total');

    return {
      ok:              true,
      restoredYoutube: restoredYoutube,
      restoredDownload: restoredDownload,
      skipped:         skipped,
      caps:            caps,
      phase:           summary.phase || null,
      jobId:           job.id || null,
    };
  }

  /**
   * Busca el último job backend_videos completado y restaura sus resultados
   * a MEDIA.videos / VIDEO_ENGINE.jobs.
   *
   * Uso desde consola para QA:
   *   restoreBackendVideoResultsFromCloud('mi-course-id').then(console.log)
   *
   * @param {string} [courseId]
   * @returns {Promise<{ok, restoredYoutube, restoredDownload, skipped, caps, phase?, jobId?, error?}>}
   */
  async function restoreBackendVideoResultsFromCloud(courseId) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId) return { ok: false, error: 'no_course_id' };

    console.log('[Cursia:video-restore] Buscando job backend_videos para:', courseId);

    var statusRes = await getBackendVideoJobStatus(courseId);
    if (!statusRes.ok || !statusRes.job) {
      console.warn('[Cursia:video-restore] No se encontró job backend_videos:', statusRes.error);
      return { ok: false, error: statusRes.error || 'no_job_found' };
    }

    var job = statusRes.job;
    var summary = _jobField(job, 'output_summary', 'outputSummary') || {};
    var phase = summary.phase || '';
    var ws = _jobField(job, 'worker_status', 'workerStatus') || '';

    console.log('[Cursia:video-restore] Job encontrado:', job.id, '— phase:', phase, '— workerStatus:', ws);

    var RESTORABLE_PHASES = ['youtube_completed', 'videogen_completed', 'submitted', 'polling', 'blocked_auth', 'blocked_quota'];
    if (RESTORABLE_PHASES.indexOf(phase) === -1 && ws !== 'completed') {
      return {
        ok:    false,
        error: 'job_not_ready',
        phase: phase,
        ws:    ws,
        jobId: job.id,
      };
    }

    var result = restoreBackendVideoResultsFromJob(job);
    console.log('[Cursia:video-restore] Restauración completada:', result);
    return result;
  }

  /**
   * Valida si los videos restaurados desde backend son utilizables por el
   * flujo H5P / MBZ patch del frontend.
   *
   * Criterios:
   *   - 'youtube_ready'  : MEDIA.videos['vN'] tiene una URL YouTube → H5P puede usarlo.
   *   - 'download_only'  : Solo downloadUrl en VIDEO_ENGINE.jobs[N] → Videogen OK, YouTube pendiente.
   *   - 'missing'        : Ni URL YouTube ni downloadUrl → capítulo sin video.
   *
   * @param {{ expectedCaps?: number }} [options]
   * @returns {{
   *   ok: boolean,
   *   totalVideos: number,
   *   youtubeReadyCount: number,
   *   downloadOnlyCount: number,
   *   missingCount: number,
   *   h5pReadyCount: number,
   *   caps: Array<{ cap, status, youtubeUrl, downloadUrl, title, h5pReady }>,
   *   summary: string,
   *   error?: string
   * }}
   */
  function validateRestoredVideosForH5P(options) {
    options = options || {};
    var expectedCaps = options.expectedCaps || null;
    var youtubeState = (typeof window.videoEngineGetYoutubeRecoveryState === 'function')
      ? window.videoEngineGetYoutubeRecoveryState()
      : { status: 'idle', pendingCaps: [], message: null };

    // Determine expected cap count from course data
    if (!expectedCaps) {
      if (window.D && Array.isArray(window.D.caps) && window.D.caps.length > 0) {
        expectedCaps = window.D.caps.length;
      } else if (window.VIDEO_ENGINE && window.VIDEO_ENGINE.jobs) {
        var maxCap = 0;
        Object.keys(window.VIDEO_ENGINE.jobs || {}).forEach(function (k) {
          var n = parseInt(k, 10);
          if (!isNaN(n) && n > maxCap) maxCap = n;
        });
        if (maxCap > 0) expectedCaps = maxCap;
      }
    }

    if (!expectedCaps) {
      return {
        ok: false,
        error: 'no_expected_caps',
        message: 'No se pudo determinar el número de capítulos. Pasa { expectedCaps: N } o asegúrate de que D.caps esté cargado.',
        totalVideos: 0, youtubeReadyCount: 0, downloadOnlyCount: 0, missingCount: 0, h5pReadyCount: 0, caps: [], summary: '',
      };
    }

    var caps            = [];
    var youtubeReadyCount = 0;
    var downloadOnlyCount = 0;
    var missingCount    = 0;
    var reconnectCount  = 0;
    var quotaBlockedCount = 0;
    var retryPendingCount = 0;

    for (var i = 1; i <= expectedCaps; i++) {
      var youtubeUrl  = (window.MEDIA && window.MEDIA.videos && window.MEDIA.videos['v' + i]) || null;
      var veJob       = (window.VIDEO_ENGINE && window.VIDEO_ENGINE.jobs && window.VIDEO_ENGINE.jobs[i]) || null;
      var downloadUrl = (veJob && (veJob.download_url || veJob.downloadUrl)) || null;
      var capTitle    = (veJob && veJob.title)
                     || (window.D && Array.isArray(window.D.caps) && window.D.caps[i - 1] && window.D.caps[i - 1].t)
                     || null;

      var status;
      if (youtubeUrl) {
        status = 'youtube_ready';
        youtubeReadyCount++;
      } else if (veJob && veJob.youtube_phase === 'needs_reconnect') {
        status = 'needs_reconnect';
        downloadOnlyCount++;
        reconnectCount++;
      } else if (veJob && veJob.youtube_phase === 'quota_blocked') {
        status = 'quota_blocked';
        downloadOnlyCount++;
        quotaBlockedCount++;
      } else if (veJob && veJob.youtube_phase === 'youtube_failed') {
        status = 'pending_retry';
        downloadOnlyCount++;
        retryPendingCount++;
      } else if (downloadUrl) {
        status = 'download_only';
        downloadOnlyCount++;
      } else {
        status = 'missing';
        missingCount++;
      }

      caps.push({
        cap:         i,
        status:      status,
        youtubeUrl:  youtubeUrl || null,
        downloadUrl: downloadUrl || null,
        title:       capTitle || null,
        h5pReady:    !!youtubeUrl,
        retryCount:  veJob && typeof veJob.retryCount === 'number' ? veJob.retryCount : 0,
        lastAttemptAt: veJob && (veJob.lastAttemptAt || veJob.youtube_last_attempt_at) || null,
      });
    }

    var totalVideos = youtubeReadyCount + downloadOnlyCount;
    var ok = youtubeReadyCount === expectedCaps && downloadOnlyCount === 0 && missingCount === 0;
    var summary = 'YouTube: ' + youtubeReadyCount + ' ✅, Pendientes: ' + downloadOnlyCount + ' ⏳, Missing: ' + missingCount + ' ❌ / ' + expectedCaps + ' caps';

    console.log('[Cursia:video-validate] ' + summary);
    caps.forEach(function (c) {
      console.log('  Cap ' + c.cap + ' [' + c.status + ']' + (c.title ? ' "' + c.title + '"' : '') + (c.youtubeUrl ? ' → ' + c.youtubeUrl : '') + (c.downloadUrl && !c.youtubeUrl ? ' → download: ' + c.downloadUrl.slice(0, 60) : ''));
    });

    return {
      ok:               ok,
      totalVideos:      totalVideos,
      youtubeReadyCount: youtubeReadyCount,
      downloadOnlyCount: downloadOnlyCount,
      missingCount:     missingCount,
      reconnectCount:   reconnectCount,
      quotaBlockedCount: quotaBlockedCount,
      retryPendingCount: retryPendingCount,
      youtubeStatus:    youtubeState.status || 'idle',
      youtubeMessage:   youtubeState.message || null,
      pendingCaps:      Array.isArray(youtubeState.pendingCaps) ? youtubeState.pendingCaps : [],
      needsReconnect:   (youtubeState.status === 'needs_reconnect') || reconnectCount > 0,
      quotaBlocked:     (youtubeState.status === 'quota_blocked') || quotaBlockedCount > 0,
      h5pReadyCount:    youtubeReadyCount,
      caps:             caps,
      summary:          summary,
    };
  }

  /**
   * Genera entradas MEDIA_HVP para los capítulos que ya tienen youtubeUrl
   * en MEDIA.videos (restaurados desde backend con restoreBackendVideoResultsFromCloud).
   *
   * Crea placeholders H5P con h5p_status='transcript_missing' y questions=[],
   * siguiendo el mismo patrón que processMedia() en modo estricto sin transcripción.
   *
   * Los capítulos con status='download_only' o 'missing' se saltan con mensaje claro.
   * Para generar preguntas reales, usa processMedia() después (requiere DOM).
   *
   * @param {{
   *   expectedCaps?: number,
   *   force?: boolean   — si true, sobreescribe entradas ya existentes
   * }} [options]
   * @returns {Promise<{
   *   ok: boolean,
   *   generatedCount: number,
   *   skippedCount: number,
   *   missingCount: number,
   *   mediaHvpCount: number,
   *   caps: Array<{cap, status, youtubeUrl?, capName?, reason?}>,
   *   summary: string
   * }>}
   */
  async function generateH5PFromRestoredVideos(options) {
    options = options || {};
    var force = options.force === true;

    // 1. Validate which caps are h5pReady
    var validation = validateRestoredVideosForH5P(options);
    if (validation.error === 'no_expected_caps') {
      console.warn('[Cursia:h5p-restore] ' + validation.message);
      return {
        ok: false, error: validation.error,
        generatedCount: 0, skippedCount: 0, missingCount: 0, mediaHvpCount: 0, caps: [], summary: '',
      };
    }

    // 2. Init MEDIA_HVP
    if (!window.MEDIA_HVP) window.MEDIA_HVP = {};

    var generatedCount = 0;
    var skippedCount   = 0;
    var missingCount   = 0;
    var resultCaps     = [];

    for (var ci = 0; ci < validation.caps.length; ci++) {
      var capInfo = validation.caps[ci];
      var cap     = capInfo.cap;

      // Skip caps without YouTube URL
      if (!capInfo.h5pReady) {
        var reason = capInfo.status === 'download_only'
          ? 'youtube_pending — Videogen listo, falta subir a YouTube'
          : 'no_video — sin video en este capítulo';
        console.log('[Cursia:h5p-restore] Cap ' + cap + ' omitido: ' + reason);
        skippedCount++;
        missingCount++;
        resultCaps.push({ cap: cap, status: 'skipped', reason: reason });
        continue;
      }

      // Skip already-generated unless force
      if (!force && window.MEDIA_HVP[cap] && window.MEDIA_HVP[cap].h5p_status === 'ready') {
        console.log('[Cursia:h5p-restore] Cap ' + cap + ' ya tiene h5p_status=ready — omitido (usa force:true para regenerar)');
        skippedCount++;
        resultCaps.push({ cap: cap, status: 'already_ready', youtubeUrl: capInfo.youtubeUrl });
        continue;
      }

      var youtubeUrl = capInfo.youtubeUrl;
      var capName    = capInfo.title
                    || (window.D && Array.isArray(window.D.caps) && window.D.caps[cap - 1] && window.D.caps[cap - 1].t)
                    || 'Capítulo ' + cap;

      // 3. Build H5P JSON — empty questions (transcript_missing placeholder)
      var hvpJson;
      if (typeof buildHvpJson === 'function') {
        hvpJson = buildHvpJson(youtubeUrl, [], capName);
      } else {
        // Minimal inline fallback when buildHvpJson not loaded yet
        hvpJson = {
          interactiveVideo: {
            video: { files: [{ path: youtubeUrl, mime: 'video/YouTube', copyright: {}, aspectRatio: '16:9' }] },
            assets: { interactions: [], bookmarks: [], endscreens: [] },
            summary: { task: {}, displayAt: 3 },
          },
          override: { showSolutionButton: 'on', retryButton: 'on', checkButton: true },
          l10n: {},
          _source: 'backend_restore_fallback',
        };
      }

      window.MEDIA_HVP[cap] = {
        hvpJson:          hvpJson,
        capName:          capName,
        youtubeUrl:       youtubeUrl,
        h5p_status:       'transcript_missing',
        transcript_source: null,
        generated_by:     'backend_videos_restore',
        generated_at:     new Date().toISOString(),
      };

      // 4. Set MBZ sentinel (used by mbzPatchToBlob to know an HVP activity exists)
      //    Prefix (not overwrite) to preserve any AI-generated design HTML already there.
      if (typeof window.F !== 'undefined' && window.F !== null) {
        var _sentinelKey1 = 'cap' + cap + '_video_interactivo.html';
        window.F[_sentinelKey1] = '<!-- HVP:' + cap + ' -->' + (window.F[_sentinelKey1] || '');
      }

      generatedCount++;
      resultCaps.push({ cap: cap, status: 'generated', youtubeUrl: youtubeUrl, capName: capName });
      console.log('[Cursia:h5p-restore] Cap ' + cap + ' → MEDIA_HVP[' + cap + '] placeholder creado (transcript_missing)');
    }

    // 5. Persist MEDIA_HVP to IndexedDB
    if (generatedCount > 0 && typeof _idbPut === 'function') {
      (typeof window.saveMediaHvp === 'function' ? window.saveMediaHvp(window.MEDIA_HVP) : _idbPut('files', 'MEDIA_HVP', window.MEDIA_HVP));
      console.log('[Cursia:h5p-restore] MEDIA_HVP persistido en IndexedDB (' + Object.keys(window.MEDIA_HVP).length + ' entradas)');
    }

    var mediaHvpCount = Object.keys(window.MEDIA_HVP || {}).length;
    var ok = generatedCount > 0;
    var summary = 'Generados: ' + generatedCount + ' ✅, Omitidos: ' + skippedCount + ' ⏩, Sin video: ' + missingCount + ' ❌';

    console.log('[Cursia:h5p-restore] ' + summary + ' — MEDIA_HVP total: ' + mediaHvpCount);
    return { ok: ok, generatedCount: generatedCount, skippedCount: skippedCount, missingCount: missingCount, mediaHvpCount: mediaHvpCount, caps: resultCaps, summary: summary };
  }

  /**
   * Valida que los H5P restaurados desde backend estén listos para ser
   * empaquetados en un MBZ (ya sea generado localmente o mediante patch).
   *
   * Verifica para cada cap restaurado:
   *   ✅ F['capN_video_interactivo.html'] existe y contiene '<!-- HVP:N -->'
   *   ✅ MEDIA_HVP[N] existe
   *   ✅ MEDIA_HVP[N].hvpJson existe (datos H5P reales)
   *   ✅ MEDIA_HVP[N].youtubeUrl existe (URL de video)
   *   ✅ MEDIA_HVP[N].h5p_status existe
   *
   * Flujo MBZ que habilita (local/híbrido):
   *   1. exportMBZ()       → crea MBZ con labels sentinel <!-- HVP:N -->
   *   2. mbzPatchToBlob()  → lee MBZ, inyecta MEDIA_HVP[N].hvpJson como actividad HVP real
   *
   * @returns {{
   *   ok: boolean,
   *   mbzReadyCount: number,
   *   issuesCount: number,
   *   caps: Array<{
   *     cap, sentinelOk, hvpEntryOk, hvpJsonOk, youtubeUrlOk,
   *     h5pStatusOk, mbzReady, issues: string[]
   *   }>,
   *   summary: string
   * }}
   */
  function validateRestoredH5PForMbz() {
    var hvpData  = window.MEDIA_HVP || {};
    var fFiles   = window.F         || {};
    var caps     = [];
    var mbzReadyCount = 0;
    var issuesCount   = 0;

    // Inspect every MEDIA_HVP entry
    Object.keys(hvpData).forEach(function (capStr) {
      var cap       = parseInt(capStr, 10);
      var hvpEntry  = hvpData[cap];
      var sentinelKey = 'cap' + cap + '_video_interactivo.html';
      var issues    = [];

      // ── Check F sentinel ──────────────────────────────────────────────
      var sentinelVal = fFiles[sentinelKey];
      var expectedSentinel = '<!-- HVP:' + cap + ' -->';
      // Prefijo, no igualdad estricta: el sentinel puede llevar diseño HTML de IA a continuación.
      var sentinelOk = typeof sentinelVal === 'string' && sentinelVal.indexOf(expectedSentinel) === 0;
      if (!sentinelOk) {
        issues.push(!sentinelVal
          ? 'F["' + sentinelKey + '"] no existe'
          : 'F["' + sentinelKey + '"] = "' + String(sentinelVal).slice(0, 40) + '" (esperado prefijo: "' + expectedSentinel + '")'
        );
      }

      // ── Check MEDIA_HVP entry ─────────────────────────────────────────
      var hvpEntryOk  = !!(hvpEntry && typeof hvpEntry === 'object');
      var hvpJsonOk   = !!(hvpEntry && hvpEntry.hvpJson && typeof hvpEntry.hvpJson === 'object');
      var youtubeUrlOk = !!(hvpEntry && hvpEntry.youtubeUrl && typeof hvpEntry.youtubeUrl === 'string' && hvpEntry.youtubeUrl.length > 4);
      var h5pStatusOk  = !!(hvpEntry && hvpEntry.h5p_status);

      if (!hvpEntryOk)  issues.push('MEDIA_HVP[' + cap + '] no existe o no es un objeto');
      if (!hvpJsonOk)   issues.push('MEDIA_HVP[' + cap + '].hvpJson falta o es inválido');
      if (!youtubeUrlOk) issues.push('MEDIA_HVP[' + cap + '].youtubeUrl falta o está vacío');
      if (!h5pStatusOk) issues.push('MEDIA_HVP[' + cap + '].h5p_status falta');

      var mbzReady = sentinelOk && hvpEntryOk && hvpJsonOk && youtubeUrlOk;

      if (mbzReady) {
        mbzReadyCount++;
      } else {
        issuesCount += issues.length;
      }

      caps.push({
        cap:          cap,
        sentinelOk:   sentinelOk,
        hvpEntryOk:   hvpEntryOk,
        hvpJsonOk:    hvpJsonOk,
        youtubeUrlOk: youtubeUrlOk,
        h5pStatusOk:  h5pStatusOk,
        h5pStatus:    hvpEntry && hvpEntry.h5p_status || null,
        youtubeUrl:   hvpEntry && hvpEntry.youtubeUrl || null,
        mbzReady:     mbzReady,
        issues:       issues,
      });
    });

    // Sort by cap number
    caps.sort(function (a, b) { return a.cap - b.cap; });

    var total   = caps.length;
    var ok      = mbzReadyCount > 0 && issuesCount === 0;
    var summary = 'MBZ-ready: ' + mbzReadyCount + '/' + total
      + (issuesCount > 0 ? ' (' + issuesCount + ' issues)' : ' ✅');

    console.log('[Cursia:h5p-mbz-validate] ' + summary);
    caps.forEach(function (c) {
      var icon = c.mbzReady ? '✅' : '⚠️';
      console.log('  Cap ' + c.cap + ' ' + icon
        + ' sentinel=' + (c.sentinelOk ? '✅' : '❌')
        + ' hvpJson='  + (c.hvpJsonOk  ? '✅' : '❌')
        + ' ytUrl='    + (c.youtubeUrlOk ? '✅' : '❌')
        + ' status='   + (c.h5pStatus || 'n/a')
        + (c.issues.length ? ' | issues: ' + c.issues.join('; ') : '')
      );
    });

    return {
      ok:           ok,
      mbzReadyCount: mbzReadyCount,
      issuesCount:  issuesCount,
      caps:         caps,
      summary:      summary,
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Fase 2 — H5P Snapshot Artifact
  // Guarda MEDIA_HVP como artifact h5p_snapshot y permite restaurarlo
  // desde nube tras reload, evitando regenerar actividades interactivas.
  // ──────────────────────────────────────────────────────────────

  /**
   * Sube MEDIA_HVP actual como artifact type='h5p_snapshot'.
   * Fire-and-forget friendly — si falla, MEDIA_HVP sigue en IndexedDB.
   *
   * @param {{ reason?: string, source?: string }} [options]
   * @returns {Promise<{ok, artifactId?, error?}>}
   */
  function uploadH5PSnapshotArtifact(options) {
    var hvp      = window.MEDIA_HVP || {};
    var hvpCount = Object.keys(hvp).length;
    if (!hvpCount) {
      return Promise.resolve({ ok: false, skipped: 'empty_hvp' });
    }
    if (typeof artifactUpload !== 'function' || !window.SB_USER || !window.ACTIVE_COURSE_ID) {
      return Promise.resolve({ ok: false, error: 'artifact_unavailable' });
    }

    var courseId   = window.ACTIVE_COURSE_ID;
    var courseName = (window.D && window.D.nombre) || 'Curso Cursia';
    var ts         = new Date().toISOString();
    var snapshot   = {
      type:         'h5p_snapshot',
      schemaVersion: '1.0',
      generatedAt:  ts,
      course:       { id: courseId, name: courseName },
      MEDIA_HVP:    hvp,
      metadata: {
        source:     (options && options.source) || 'processMedia',
        reason:     (options && options.reason) || 'multimedia_completed',
        hvpCount:   hvpCount,
        courseName: courseName,
        generatedAt: ts
      }
    };

    var filename = 'h5p_snapshot_' + ts.replace(/[:.]/g, '-') + '.json';
    var metadata = {
      reason:      snapshot.metadata.reason,
      courseName:  courseName,
      hvpCount:    hvpCount,
      generatedAt: ts
    };

    return artifactUpload('h5p_snapshot', snapshot, filename, 'application/json', metadata, {
      storageFolder: 'content'
    }).then(function (res) {
      if (res && res.ok) {
        console.log('[Cursia:h5p-snapshot] Artifact guardado:', filename, '— hvpCount:', hvpCount);
      } else {
        console.warn('[Cursia:h5p-snapshot] No se pudo guardar:', res && res.error);
      }
      return res || { ok: false };
    }).catch(function (e) {
      console.warn('[Cursia:h5p-snapshot] Upload falló:', e && e.message);
      return { ok: false, error: e && e.message || 'upload_error' };
    });
  }

  /**
   * Restaura MEDIA_HVP desde artifact h5p_snapshot en nube.
   * También restaura los sentinels F['capN_video_interactivo.html'].
   *
   * @param {string} [courseId]
   * @returns {Promise<{ok, hvpCount?, error?}>}
   */
  function restoreH5PSnapshotFromCloud(courseId) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId || typeof artifactList !== 'function'
        || typeof artifactDownloadUrl !== 'function' || !window.SB_USER) {
      return Promise.resolve({ ok: false, error: 'unavailable' });
    }

    return artifactList({ course_id: String(courseId), type: 'h5p_snapshot' }).then(function (res) {
      if (!res.ok || !res.data || !res.data.length) {
        return { ok: false, error: 'no_snapshot' };
      }
      var sorted = res.data.slice().sort(function (a, b) {
        return new Date(b.created_at || b.createdAt || 0)
             - new Date(a.created_at || a.createdAt || 0);
      });
      var artifact = sorted[0];

      return artifactDownloadUrl(artifact.id).then(function (urlRes) {
        var url = urlRes && urlRes.url;
        if (!url) return { ok: false, error: 'no_url' };

        return fetch(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function (snapshot) {
          if (!snapshot || typeof snapshot.MEDIA_HVP !== 'object') {
            return { ok: false, error: 'invalid_snapshot' };
          }

          var hvp      = snapshot.MEDIA_HVP;
          var hvpCount = Object.keys(hvp).length;

          // Restaurar MEDIA_HVP en memoria
          window.MEDIA_HVP = hvp;

          // Restaurar sentinels en F para que mbzPatchToBlob los detecte
          // Prefijar (no sobreescribir) para preservar cualquier diseño HTML ya generado por IA.
          Object.keys(hvp).forEach(function (capStr) {
            var cap = parseInt(capStr, 10);
            if (isNaN(cap)) return;
            window.F = window.F || {};
            var _sentinelKey2 = 'cap' + cap + '_video_interactivo.html';
            window.F[_sentinelKey2] = '<!-- HVP:' + cap + ' -->' + (window.F[_sentinelKey2] || '');
          });

          // Persistir en IndexedDB también
          if (typeof _idbPut === 'function') {
            (typeof window.saveMediaHvp === 'function' ? window.saveMediaHvp(hvp) : _idbPut('files', 'MEDIA_HVP', hvp));
          }

          console.log('[Cursia:h5p-snapshot] Restaurado desde nube — hvpCount:', hvpCount);
          return { ok: true, hvpCount: hvpCount };
        });
      });
    }).catch(function (e) {
      console.warn('[Cursia:h5p-snapshot] Restore falló:', e && e.message);
      return { ok: false, error: e && e.message || 'restore_error' };
    });
  }

  /**
   * Orquestador del flujo híbrido backend → frontend.
   * Conecta en orden todos los pasos ya implementados para preparar el curso.
   *
   * Pasos:
   *   1. restoreContentSnapshotFromCloud  → restaura D/F del content_snapshot
   *   2. restoreBackendVideoResultsFromCloud → rellena MEDIA.videos + VIDEO_ENGINE.jobs
   *   3. validateRestoredVideosForH5P     → diagnóstico por capítulo
   *   4. generateH5PFromRestoredVideos   → crea MEDIA_HVP + F sentinels
   *   5. validateRestoredH5PForMbz       → confirma que el MBZ puede incluirlos
   *   6. finaliza el paquete Moodle [si autoFinalize/generateMbz:true]
   *
   * Por defecto NO finaliza el paquete automáticamente — solo prepara y valida.
   *
   * @param {{
   *   courseId?:    string,
   *   generateMbz?: boolean,   — compat legacy; si true, intenta finalizar paquete
   *   autoFinalize?: boolean,  — si true, genera y guarda el paquete final
   *   skipDownload?: boolean,  — evita descarga automática al finalizar
   *   skipContent?: boolean,   — si true, omite el paso de content snapshot
   * }} [options]
   * @returns {Promise<{
   *   ok: boolean,
   *   courseId: string,
   *   contentRestored: boolean,
   *   videosRestored: boolean,
   *   videoValidation: object,
   *   h5pGenerated: boolean,
   *   h5pMbzValidation: object,
   *   mbzReady: boolean,
   *   mbzGenerated: boolean,
   *   mbzStoredInCloud: boolean,
   *   courseReady: boolean,
   *   warnings: string[],
   *   nextAction: string,
   *   error?: string
   * }>}
   */
  async function runHybridBackendCourseFlow(options) {
    options = options || {};
    var courseId     = options.courseId    || window.ACTIVE_COURSE_ID || null;
    var generateMbz  = options.generateMbz === true;
    var autoFinalize = options.autoFinalize === true;
    var skipDownload = options.skipDownload !== false;
    var skipContent  = options.skipContent === true;

    if (!courseId) {
      return {
        ok: false, error: 'no_course_id',
        message: 'Pasa { courseId: "..." } o asegúrate de tener un curso activo (ACTIVE_COURSE_ID).',
        warnings: [], nextAction: 'Especifica un courseId',
      };
    }

    var warnings = [];
    var result = {
      ok:                  false,
      courseId:            courseId,
      contentRestored:     false,
      contentError:        null,
      videosRestored:      false,
      videoRestoreResult:  null,
      videoValidation:     null,
      h5pGenerated:        false,
      h5pGenerateResult:   null,
      h5pMbzValidation:    null,
      mbzReady:            false,
      mbzGenerated:        false,
      mbzStoredInCloud:    false,
      courseReady:         false,
      youtubeRecoveryResult: null,
      audiobookReady:      false,
      audiobookGenerated:  false,
      audiobookSkipped:    false,
      audiobookSizeMb:     null,
      warnings:            warnings,
      nextAction:          null,
    };

    console.log('[Cursia:hybrid-flow] ─── runHybridBackendCourseFlow ──── courseId:', courseId,
      '| generateMbz:', generateMbz, '| skipContent:', skipContent);

    // ── Step 1: Restore content snapshot ────────────────────────────────
    if (!skipContent && typeof restoreContentSnapshotFromCloud === 'function') {
      console.log('[Cursia:hybrid-flow] Step 1: restoreContentSnapshotFromCloud...');
      try {
        var contentRes = await restoreContentSnapshotFromCloud(courseId);
        if (contentRes && contentRes.ok) {
          result.contentRestored = true;
          console.log('[Cursia:hybrid-flow] Step 1 ✅ Content snapshot restaurado');
        } else {
          var cErr = (contentRes && contentRes.error) || 'unknown';
          var isExpected = ['no_artifact_found', 'no_jobs_found', 'no_content_jobs',
            'backend_off', 'no_course_id'].indexOf(cErr) >= 0;
          result.contentError = cErr;
          if (isExpected) {
            warnings.push('Step 1: content snapshot no disponible para este curso (' + cErr + ')');
          } else {
            warnings.push('Step 1 error: ' + cErr);
          }
          console.warn('[Cursia:hybrid-flow] Step 1 ⚠️', cErr);
        }
      } catch (e) {
        var em = e && e.message ? e.message : String(e);
        warnings.push('Step 1 exception: ' + em);
        console.warn('[Cursia:hybrid-flow] Step 1 exception:', em);
      }
    } else if (skipContent) {
      console.log('[Cursia:hybrid-flow] Step 1 skipped (skipContent=true)');
    }

    // ── Step 2: Restore backend video results ───────────────────────────
    console.log('[Cursia:hybrid-flow] Step 2: restoreBackendVideoResultsFromCloud...');
    try {
      var videoRes = await restoreBackendVideoResultsFromCloud(courseId);
      result.videoRestoreResult = videoRes;
      if (videoRes && videoRes.ok) {
        result.videosRestored = true;
        console.log('[Cursia:hybrid-flow] Step 2 ✅ Videos restaurados: youtube='
          + videoRes.restoredYoutube + ', download=' + videoRes.restoredDownload);
      } else {
        var vErr = (videoRes && videoRes.error) || 'no_video_jobs';
        warnings.push('Step 2: no se restauraron videos (' + vErr + ')');
        console.warn('[Cursia:hybrid-flow] Step 2 ⚠️', vErr);
      }
    } catch (e) {
      var em2 = e && e.message ? e.message : String(e);
      warnings.push('Step 2 exception: ' + em2);
      console.warn('[Cursia:hybrid-flow] Step 2 exception:', em2);
    }

    // ── Step 3: Validate videos for H5P ─────────────────────────────────
    console.log('[Cursia:hybrid-flow] Step 3: validateRestoredVideosForH5P...');
    var videoVal = validateRestoredVideosForH5P();
    result.videoValidation = videoVal;
    var v3icon = videoVal.youtubeReadyCount > 0 ? '✅' : '⚠️';
    console.log('[Cursia:hybrid-flow] Step 3 ' + v3icon + ' ' + videoVal.summary);
    if (videoVal.youtubeReadyCount === 0) {
      warnings.push('Step 3: ningún capítulo tiene YouTube URL lista para H5P (' + videoVal.summary + ')');
    }
    if (videoVal.downloadOnlyCount > 0 && !videoVal.needsReconnect && !videoVal.quotaBlocked) {
      warnings.push('Step 3: ' + videoVal.downloadOnlyCount + ' cap(s) en download_only — pendiente subir a YouTube');
    }

    if (videoVal.needsReconnect) {
      warnings.push('Step 3: necesitas reconectar YouTube para continuar.');
    } else if (videoVal.quotaBlocked) {
      warnings.push('Step 3: YouTube no permitió subir más videos por ahora.');
    } else if ((videoVal.downloadOnlyCount > 0 || videoVal.retryPendingCount > 0)
               && typeof recoverVideoUploadsAndContinue === 'function') {
      console.log('[Cursia:hybrid-flow] Step 3.5: recoverVideoUploadsAndContinue...');
      try {
        if (typeof options.onStatus === 'function') {
          options.onStatus({ stage: 'retrying_youtube', message: 'Reintentando videos pendientes…' });
        }
        var recoverRes = await recoverVideoUploadsAndContinue({
          maxCaps: (window.D && window.D.caps && window.D.caps.length) || 9,
          continuePipeline: false,
          onProgress: function (msg) {
            if (typeof options.onStatus === 'function') {
              options.onStatus({ stage: 'retrying_youtube', message: msg });
            }
          },
        });
        result.youtubeRecoveryResult = recoverRes;
        videoVal = validateRestoredVideosForH5P();
        result.videoValidation = videoVal;
        if (recoverRes && recoverRes.needsReauth) {
          warnings.push('Step 3.5: necesitas reconectar YouTube para continuar.');
        } else if (recoverRes && recoverRes.failed && recoverRes.failed.length > 0) {
          warnings.push('Step 3.5: faltan videos por subir a YouTube.');
        }
      } catch (e) {
        var em35 = e && e.message ? e.message : String(e);
        warnings.push('Step 3.5 exception: ' + em35);
      }
    }

    // ── Step 4: Generate H5P ─────────────────────────────────────────────
    console.log('[Cursia:hybrid-flow] Step 4: generateH5PFromRestoredVideos...');
    try {
      var h5pRes = await generateH5PFromRestoredVideos();
      result.h5pGenerateResult = h5pRes;
      if (h5pRes && h5pRes.ok && h5pRes.generatedCount > 0) {
        result.h5pGenerated = true;
        console.log('[Cursia:hybrid-flow] Step 4 ✅ ' + h5pRes.summary);
      } else {
        var h4msg = (h5pRes && h5pRes.summary) || 'generatedCount=0';
        warnings.push('Step 4: H5P no generado — ' + h4msg);
        console.warn('[Cursia:hybrid-flow] Step 4 ⚠️', h4msg);
      }
    } catch (e) {
      var em4 = e && e.message ? e.message : String(e);
      warnings.push('Step 4 exception: ' + em4);
      console.warn('[Cursia:hybrid-flow] Step 4 exception:', em4);
    }

    // ── Step 5: Validate H5P for MBZ ─────────────────────────────────────
    console.log('[Cursia:hybrid-flow] Step 5: validateRestoredH5PForMbz...');
    var mbzVal = validateRestoredH5PForMbz();
    result.h5pMbzValidation = mbzVal;
    result.mbzReady = mbzVal.ok && mbzVal.mbzReadyCount > 0;
    var v5icon = result.mbzReady ? '✅' : '⚠️';
    console.log('[Cursia:hybrid-flow] Step 5 ' + v5icon + ' ' + mbzVal.summary);
    if (!result.mbzReady) {
      warnings.push('Step 5: ' + mbzVal.summary);
    }

    // ── Step 5.5: Audiobook ──────────────────────────────────────────────
    console.log('[Cursia:hybrid-flow] Step 5.5: Audiobook check...');
    var _abAlreadyExists = !!(window.MEDIA && window.MEDIA.audiolibro && window.MEDIA.audiolibro.size > 0);

    if (_abAlreadyExists) {
      result.audiobookReady   = true;
      result.audiobookSkipped = true;
      var _abSizeMb = (window.MEDIA.audiolibro.size / 1024 / 1024).toFixed(1);
      result.audiobookSizeMb = _abSizeMb;
      console.log('[Cursia:hybrid-flow] Step 5.5 ✅ Audiobook already in memory (' + _abSizeMb + ' MB) — skipping generation');
    } else {
      // Check prerequisites: need book content to generate
      var _abHasSource = (typeof D !== 'undefined' && D && D.nombre)
        || (typeof F !== 'undefined' && Object.keys(F || {}).some(function (k) { return /^libro_cap\d+\.md$/.test(k); }));

      if (!_abHasSource) {
        result.audiobookSkipped = true;
        warnings.push('Step 5.5: sin contenido del curso para generar audiolibro — genera el contenido primero');
        console.warn('[Cursia:hybrid-flow] Step 5.5 ⚠️ No source material for audiobook');
      } else if (typeof window.generateAudiobookOpenAI !== 'function') {
        result.audiobookSkipped = true;
        warnings.push('Step 5.5: módulo de audiolibro no disponible');
        console.warn('[Cursia:hybrid-flow] Step 5.5 ⚠️ generateAudiobookOpenAI not available');
      } else {
        // Notify progress if callback provided
        if (typeof options.onAudiobookProgress === 'function') {
          options.onAudiobookProgress({ status: 'generating', message: 'Generando audiolibro…' });
        }
        console.log('[Cursia:hybrid-flow] Step 5.5: Calling generateAudiobookOpenAI...');
        try {
          var _abResult = await window.generateAudiobookOpenAI({
            maxCap: 9,
            onProgress: function (prog) {
              if (typeof options.onAudiobookProgress === 'function') {
                options.onAudiobookProgress(prog);
              }
            },
          });
          result.audiobookReady     = !!(window.MEDIA && window.MEDIA.audiolibro);
          result.audiobookGenerated = !!(_abResult && _abResult.ok);
          if (result.audiobookReady) {
            var _abNewSize = (window.MEDIA.audiolibro.size / 1024 / 1024).toFixed(1);
            result.audiobookSizeMb = _abNewSize;
            console.log('[Cursia:hybrid-flow] Step 5.5 ✅ Audiobook generated (' + _abNewSize + ' MB)');
          } else {
            warnings.push('Step 5.5: el audiolibro no se guardó correctamente en memoria');
            console.warn('[Cursia:hybrid-flow] Step 5.5 ⚠️ MEDIA.audiolibro not set after generation');
          }
        } catch (e) {
          var _abEm = e && e.message ? e.message : String(e);
          result.audiobookSkipped = true;
          warnings.push('Step 5.5: no pudimos generar el audiolibro — ' + _abEm.slice(0, 100));
          console.warn('[Cursia:hybrid-flow] Step 5.5 ⚠️ Audiobook generation failed:', _abEm);
        }
      }
    }

    // ── Step 6 (optional): Finalize package ──────────────────────────────
    if (autoFinalize || generateMbz) {
      if (result.mbzReady && typeof recoverCurrentCourseToFinalMbz === 'function') {
        console.log('[Cursia:hybrid-flow] Step 6: recoverCurrentCourseToFinalMbz() [autoFinalize=' + autoFinalize + ']...');
        try {
          if (typeof options.onStatus === 'function') {
            options.onStatus({ stage: 'finalizing_package', message: 'Preparando paquete Moodle…' });
          }
          await recoverCurrentCourseToFinalMbz({
            allowPartial: false,
            skipDownload: skipDownload,
          });
          var cp = window.COURSE_PRODUCTION || {};
          result.mbzGenerated = !!cp.mbzReady;
          result.mbzStoredInCloud = !!cp.mbzCloudSaved;
          result.courseReady = !!(cp.mbzReady && cp.mbzCompletionLevel === 'complete' && cp.mbzCloudSaved);
          if (result.courseReady) {
            console.log('[Cursia:hybrid-flow] Step 6 ✅ Paquete final listo y guardado en la nube');
          } else if (result.mbzGenerated) {
            warnings.push('Step 6: el paquete final quedó preparado, pero no se pudo guardar todavía.');
            console.warn('[Cursia:hybrid-flow] Step 6 ⚠️ Package ready in memory but not stored in cloud');
          } else {
            warnings.push('Step 6: no se pudo finalizar el paquete Moodle.');
            console.warn('[Cursia:hybrid-flow] Step 6 ⚠️ Package finalization incomplete');
          }
        } catch (e) {
          var em6 = e && e.message ? e.message : String(e);
          warnings.push('Step 6 exception: ' + em6);
          console.warn('[Cursia:hybrid-flow] Step 6 exception:', em6);
        }
      } else if (!result.mbzReady) {
        warnings.push('Step 6: el curso todavía no está listo para empaquetarse');
        console.warn('[Cursia:hybrid-flow] Step 6 skipped: H5P not mbzReady');
      } else {
        warnings.push('Step 6: la finalización del paquete no está disponible en este contexto');
      }
    } else {
      console.log('[Cursia:hybrid-flow] Step 6 skipped (autoFinalize=false — modo preparación)');
    }

    // ── Determine next action ─────────────────────────────────────────────
    if (!result.videosRestored && !result.contentRestored) {
      result.nextAction = 'Crea un job backend_videos con createBackendVideoJob() y ejecuta el video-worker en el servidor';
    } else if (result.videoValidation && result.videoValidation.needsReconnect) {
      result.nextAction = 'Reconecta YouTube para continuar con los videos pendientes.';
    } else if (result.videoValidation && result.videoValidation.quotaBlocked) {
      result.nextAction = 'YouTube bloqueó nuevas subidas por ahora. Reintenta más tarde.';
    } else if (!result.h5pGenerated) {
      if (videoVal.downloadOnlyCount > 0) {
        result.nextAction = 'Faltan ' + videoVal.downloadOnlyCount + ' video(s) por subir a YouTube.';
      } else {
        result.nextAction = 'Revisa los warnings — no se pudo generar H5P';
      }
    } else if (result.courseReady) {
      result.nextAction = 'Curso listo — el paquete Moodle ya quedó guardado y se puede descargar.';
    } else if (result.mbzReady && !result.mbzGenerated && !autoFinalize && !generateMbz) {
      result.nextAction = 'Todo listo — solo falta preparar el paquete Moodle final.';
    } else if (result.mbzGenerated && !result.mbzStoredInCloud) {
      result.nextAction = 'El paquete quedó preparado, pero no se pudo guardar todavía.';
    } else {
      result.nextAction = 'Revisa los ' + warnings.length + ' warning(s) para más detalles';
    }

    result.ok = result.contentRestored || result.videosRestored || result.h5pGenerated || result.mbzReady || result.audiobookReady || result.courseReady;

    console.log('[Cursia:hybrid-flow] ─── Resultado ───');
    console.log('  contentRestored:', result.contentRestored);
    console.log('  videosRestored: ', result.videosRestored);
    console.log('  h5pGenerated:   ', result.h5pGenerated);
    console.log('  mbzReady:       ', result.mbzReady);
    console.log('  mbzGenerated:   ', result.mbzGenerated);
    console.log('  mbzStoredInCloud:', result.mbzStoredInCloud);
    console.log('  courseReady:    ', result.courseReady);
    console.log('  warnings:       ', warnings.length);
    console.log('  nextAction:     ', result.nextAction);

    return result;
  }

  // ──────────────────────────────────────────────────────────────
  // UI híbrida — "Preparar curso"
  // Lenguaje simple, sin términos técnicos.
  // ──────────────────────────────────────────────────────────────

  /** Genera el HTML de la sección "Preparar curso" dentro del panel nube. */
  function _renderHybridSection() {
    var courseId = (typeof window.ACTIVE_COURSE_ID !== 'undefined' && window.ACTIVE_COURSE_ID)
                || (typeof D !== 'undefined' && D && D.backendCourseId)
                || null;
    var courseHint = courseId
      ? '<span style="font-size:10px;color:rgba(3, 10, 38,.35);margin-left:6px;">' + _esc(String(courseId).slice(0,24) + (courseId.length > 24 ? '…' : '')) + '</span>'
      : '<span style="font-size:10px;color:rgba(176,110,10,.9);margin-left:6px;">— abre un curso primero —</span>';

    return (
      '<div id="hybrid-flow-section" style="margin-top:14px;padding:12px 14px;border-radius:10px;' +
        'background:rgba(96,165,250,.06);border:1px solid rgba(96,165,250,.18);">' +

        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
          '<span style="font-size:10.5px;font-weight:700;letter-spacing:.05em;color:oklch(0.46 0.20 264.7);">PREPARAR CURSO</span>' +
          courseHint +
        '</div>' +

        '<p style="font-size:12px;color:rgba(3, 10, 38,.6);margin:0 0 10px;line-height:1.6;">' +
          'Recupera el contenido y los videos guardados, crea los videos interactivos y prepara el paquete Moodle.' +
        '</p>' +

        '<button type="button" id="btn-hybrid-prepare"' +
          ' style="padding:7px 14px;border-radius:7px;border:1px solid rgba(96,165,250,.4);' +
          'background:rgba(96,165,250,.12);color:oklch(0.46 0.20 264.7);font-size:12px;font-weight:600;' +
          'cursor:pointer;display:inline-flex;align-items:center;gap:6px;">' +
          '🚀 Preparar curso' +
        '</button>' +

        '<div id="hybrid-flow-result" style="margin-top:12px;"></div>' +
      '</div>'
    );
  }

  /** Punto visible en el panel "Crear curso completo" para usuarios no avanzados. */
  function _renderHybridProductionAction() {
    var anchor = document.getElementById('cp-launch-config');
    if (!anchor) return;

    var mount = document.getElementById('cp-hybrid-prepare-wrap');
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'cp-hybrid-prepare-wrap';
      mount.style.marginTop = '12px';
      anchor.insertAdjacentElement('afterend', mount);
    }

    var courseId = (typeof window.ACTIVE_COURSE_ID !== 'undefined' && window.ACTIVE_COURSE_ID)
                || (typeof D !== 'undefined' && D && D.backendCourseId)
                || null;
    var enabled = backendIsEnabled();
    var hasSession = !!(window.SB_USER);

    var hint;
    if (!courseId) {
      hint = 'Abre o selecciona un curso para prepararlo.';
    } else if (!enabled && !hasSession) {
      hint = 'Activa la nube e inicia sesión para recuperar avances guardados.';
    } else if (!enabled) {
      hint = 'Activa la nube para recuperar avances guardados.';
    } else if (!hasSession) {
      hint = 'Inicia sesión para recuperar avances guardados.';
    } else {
      hint = 'Recupera avances guardados, crea los videos interactivos y deja listo el paquete Moodle.';
    }

    mount.innerHTML =
      '<div style="padding:12px 14px;border-radius:12px;' +
        'background:rgba(96,165,250,.06);border:1px solid rgba(96,165,250,.18);">' +
        '<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;">' +
          '<div style="min-width:240px;flex:1 1 320px;">' +
            '<div style="font-size:10.5px;font-weight:700;letter-spacing:.05em;color:oklch(0.46 0.20 264.7);margin-bottom:6px;">PREPARAR CURSO</div>' +
            '<div style="font-size:12px;color:rgba(3, 10, 38,.62);line-height:1.6;">' + _esc(hint) + '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
            '<button type="button" id="btn-hybrid-prepare-main"' +
              ' style="padding:8px 14px;border-radius:8px;border:1px solid rgba(96,165,250,.42);' +
              'background:rgba(96,165,250,.12);color:oklch(0.46 0.20 264.7);font-size:12px;font-weight:700;' +
              'cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;">' +
              '🚀 Preparar curso' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div id="hybrid-flow-result-main" style="margin-top:12px;"></div>' +
      '</div>';

    _bindHybridActionButtons();
  }

  function _bindHybridActionButtons() {
    var btnMain = document.getElementById('btn-hybrid-prepare-main');
    var btnPanel = document.getElementById('btn-hybrid-prepare');

    function _attach(btn) {
      if (!btn || btn.dataset.hybridBound === 'true') return;
      btn.dataset.hybridBound = 'true';
      btn.addEventListener('click', function () {
        runHybridFlowUI();
      });
    }

    _attach(btnMain);
    _attach(btnPanel);
  }

  function _bindHybridPackageButton() {
    var btn = document.getElementById('btn-download-moodle-package');
    if (!btn || btn.dataset.hybridBound === 'true') return;
    btn.dataset.hybridBound = 'true';
    btn.addEventListener('click', function () {
      downloadPreparedMoodlePackage();
    });
  }

  function _rememberYoutubeReconnectResume(courseId) {
    if (!courseId) return;
    try {
      localStorage.setItem('CURSIA_YOUTUBE_RESUME', JSON.stringify({
        courseId: courseId,
        action: 'resume_prepare_course',
        savedAt: new Date().toISOString(),
      }));
    } catch (e) {}
  }

  function _clearYoutubeReconnectResume() {
    try { localStorage.removeItem('CURSIA_YOUTUBE_RESUME'); } catch (e) {}
  }

  /**
   * Llama al backend para reactivar un job de video bloqueado (blocked_auth / blocked_quota).
   * El worker lo recoge automáticamente y continúa solo con los videos pendientes.
   * Los videos ya subidos se conservan (no se duplican).
   */
  function requeueBackendVideoJob(jobId) {
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, reason: 'backend_off' });
    return backendApiRequest('/api/v1/jobs/' + jobId + '/requeue', { method: 'POST' })
      .then(function (res) {
        if (!res.ok) {
          console.warn('[Cursia:requeue] Fallo al reactivar job', jobId, res.reason || res.error);
          return { ok: false, reason: res.reason || res.error };
        }
        console.log('[Cursia:requeue] Job', jobId, 'reactivado — el worker continuará con los videos pendientes');
        return { ok: true };
      })
      .catch(function (e) {
        console.warn('[Cursia:requeue] Error:', e.message);
        return { ok: false, reason: e.message };
      });
  }

  function resumeHybridFlowAfterYoutubeReconnect(courseId) {
    if (!courseId) return;

    // Si hay un job de video bloqueado (blocked_auth), reactivarlo para que el worker
    // continúe con los videos pendientes sin duplicar los ya subidos.
    getBackendVideoJobStatus(courseId).then(function (statusRes) {
      if (statusRes.ok && statusRes.job) {
        var job = statusRes.job;
        var summary = _jobField(job, 'output_summary', 'outputSummary') || {};
        var jobStatus = _jobField(job, 'status', 'status') || '';
        if ((jobStatus === 'failed_recoverable' || jobStatus === 'failed') && summary.phase === 'blocked_auth') {
          var jobId = _jobField(job, 'id', 'id') || job.id;
          console.log('[Cursia:requeue] Detectado job blocked_auth:', jobId, '— reactivando…');
          requeueBackendVideoJob(jobId).then(function () {
            if (typeof go === 'function') go('produccion');
          });
          return;
        }
      }
      if (typeof go === 'function') go('produccion');
      setTimeout(function () {
        if (typeof runHybridFlowUI === 'function') runHybridFlowUI(courseId);
      }, 250);
    }).catch(function () {
      if (typeof go === 'function') go('produccion');
      setTimeout(function () {
        if (typeof runHybridFlowUI === 'function') runHybridFlowUI(courseId);
      }, 250);
    });
  }

  function _bindHybridRecoveryButtons(courseId) {
    var reconnectBtn = document.getElementById('btn-hybrid-reconnect-youtube');
    if (reconnectBtn && reconnectBtn.dataset.hybridBound !== 'true') {
      reconnectBtn.dataset.hybridBound = 'true';
      reconnectBtn.addEventListener('click', function () {
        _rememberYoutubeReconnectResume(courseId);
        if (typeof window.youtubeConnect === 'function') {
          window.youtubeConnect();
        } else if (typeof go === 'function') {
          go('cuenta');
        }
      });
    }

    var retryBtn = document.getElementById('btn-hybrid-retry-youtube');
    if (retryBtn && retryBtn.dataset.hybridBound !== 'true') {
      retryBtn.dataset.hybridBound = 'true';
      retryBtn.addEventListener('click', function () {
        runHybridFlowUI(courseId);
      });
    }
  }

  function _getHybridUiEls() {
    return {
      btn: document.getElementById('btn-hybrid-prepare-main')
        || document.getElementById('btn-hybrid-prepare'),
      resultEl: document.getElementById('hybrid-flow-result-main')
        || document.getElementById('hybrid-flow-result'),
    };
  }

  function _setHybridPackageMessage(message, tone) {
    var el = document.getElementById('hybrid-package-result');
    if (!el) return;
    var color = tone === 'ok'
      ? 'rgba(34,197,94,.85)'
      : tone === 'error'
      ? 'rgba(239,68,68,.85)'
      : 'rgba(248,181,0,.8)';
    el.innerHTML =
      '<div style="font-size:12px;line-height:1.5;color:' + color + ';margin-top:8px;">' +
        _esc(message) +
      '</div>';
  }

  async function downloadPreparedMoodlePackage() {
    var btn = document.getElementById('btn-download-moodle-package');
    var cp = window.COURSE_PRODUCTION || {};

    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Preparando paquete...';
    }

    try {
      if (cp.mbzReady && typeof downloadFinalMbz === 'function') {
        _setHybridPackageMessage('Paquete listo. Iniciando descarga...', 'ok');
        downloadFinalMbz();
        return;
      }

      if (typeof validateRestoredH5PForMbz === 'function') {
        var readiness = validateRestoredH5PForMbz();
        if (!readiness || !readiness.ok || !readiness.mbzReadyCount) {
          _setHybridPackageMessage('Aún faltan videos o contenido para preparar el paquete Moodle.', 'warn');
          return;
        }
      }

      if (typeof recoverCurrentCourseToFinalMbz === 'function') {
        _setHybridPackageMessage('Preparando paquete Moodle...', 'warn');
        await recoverCurrentCourseToFinalMbz({ allowPartial: false });
        if (window.COURSE_PRODUCTION && window.COURSE_PRODUCTION.mbzReady && typeof downloadFinalMbz === 'function') {
          _setHybridPackageMessage('Paquete listo. Iniciando descarga...', 'ok');
          downloadFinalMbz();
          return;
        }
      } else if (typeof downloadFinalMbz === 'function') {
        _setHybridPackageMessage('Preparando paquete Moodle...', 'warn');
        downloadFinalMbz();
        _setHybridPackageMessage('Paquete listo. Iniciando descarga...', 'ok');
        return;
      } else if (typeof exportMBZ === 'function') {
        _setHybridPackageMessage('Preparando paquete Moodle...', 'warn');
        await exportMBZ();
        _setHybridPackageMessage('Paquete listo. Iniciando descarga...', 'ok');
        return;
      }

      _setHybridPackageMessage('No pudimos preparar el paquete Moodle en este momento.', 'error');
    } catch (e) {
      _setHybridPackageMessage('No pudimos preparar el paquete Moodle en este momento.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⬇️ Descargar paquete Moodle';
      }
    }
  }

  /** Traduce el resultado técnico a mensajes amigables para el usuario. */
  function _hybridFriendlyMessages(result) {
    var lines = [];

    // Contenido del curso
    if (result.contentRestored) {
      lines.push({ icon: '✅', text: 'Recuperamos el contenido del curso desde la nube.' });
    } else if (result.contentError && result.contentError !== 'no_artifact_found'
               && result.contentError !== 'no_jobs_found' && result.contentError !== 'no_content_jobs'
               && result.contentError !== 'backend_off') {
      lines.push({ icon: '⚠️', text: 'No se pudo recuperar el contenido del curso.' });
    }

    // Videos
    var vr = result.videoRestoreResult;
    if (result.videosRestored && vr) {
      var ytN = vr.restoredYoutube || 0;
      var dlN = vr.restoredDownload || 0;
      if (ytN > 0 && dlN > 0) {
        lines.push({ icon: '✅', text: 'Encontramos videos guardados y los recuperamos (' + ytN + ' con YouTube, ' + dlN + ' en proceso).' });
      } else if (ytN > 0) {
        lines.push({ icon: '✅', text: ytN === 1
          ? 'Encontramos 1 video guardado y lo recuperamos.'
          : 'Encontramos ' + ytN + ' videos guardados y los recuperamos.' });
      } else if (dlN > 0) {
        lines.push({ icon: '⏳', text: 'Encontramos ' + dlN + ' video(s) en proceso. Falta subirlos a YouTube.' });
      }
    } else if (!result.videosRestored) {
      lines.push({ icon: '—', text: 'Aún no hay videos guardados en la nube para este curso.' });
    }

    if (result.videoValidation && result.videoValidation.needsReconnect) {
      lines.push({ icon: '⚠️', text: 'Necesita reconectar YouTube para continuar.' });
    } else if (result.videoValidation && result.videoValidation.quotaBlocked) {
      lines.push({ icon: '⚠️', text: 'YouTube no permitió subir más videos por ahora. Puedes intentarlo más tarde.' });
    } else if (result.videoValidation && result.videoValidation.retryPendingCount > 0) {
      lines.push({ icon: '⏳', text: 'No pudimos subir algunos videos. Puedes reintentar.' });
    }

    // Videos interactivos
    var h5pr = result.h5pGenerateResult;
    if (result.h5pGenerated && h5pr && h5pr.generatedCount > 0) {
      var verbH5P = h5pr.generatedCount === 1 ? 'Se creó 1 video interactivo.' : 'Se crearon ' + h5pr.generatedCount + ' videos interactivos.';
      lines.push({ icon: '✅', text: verbH5P });
      if (h5pr.skippedCount > 0 && (h5pr.missingCount || 0) > 0) {
        lines.push({ icon: '⏳', text: h5pr.skippedCount + ' capítulo(s) pendiente(s) de subir a YouTube.' });
      }
    } else if (!result.h5pGenerated) {
      var vv = result.videoValidation;
      if (vv && vv.downloadOnlyCount > 0) {
        lines.push({ icon: '⏳', text: 'Falta subir ' + vv.downloadOnlyCount + ' video(s) a YouTube para crear los videos interactivos.' });
      } else {
        lines.push({ icon: '—', text: 'No se pudieron crear videos interactivos todavía.' });
      }
    }

    // Audiolibro
    if (result.audiobookReady && result.audiobookSkipped) {
      // Already existed — no need to mention unless large
      var _sizeMb = parseFloat(result.audiobookSizeMb || 0);
      if (_sizeMb > 30) {
        lines.push({ icon: '🎧', text: 'Audiolibro listo (' + result.audiobookSizeMb + ' MB). Se podrá descargar por separado.' });
      } else if (_sizeMb > 0) {
        lines.push({ icon: '🎧', text: 'Audiolibro listo.' });
      }
    } else if (result.audiobookReady && result.audiobookGenerated) {
      var _newSizeMb = parseFloat(result.audiobookSizeMb || 0);
      if (_newSizeMb > 30) {
        lines.push({ icon: '🎧', text: 'Audiolibro generado (' + result.audiobookSizeMb + ' MB). Es muy grande para el paquete, se descarga por separado.' });
      } else {
        lines.push({ icon: '🎧', text: 'Audiolibro generado y listo.' });
      }
    } else if (result.audiobookSkipped && !result.audiobookReady) {
      // Skip silently — no source material or module unavailable
    } else if (!result.audiobookReady && !result.audiobookSkipped) {
      lines.push({ icon: '⚠️', text: 'No pudimos generar el audiolibro. Puedes intentarlo de nuevo.' });
    }

    // Estado final
    var _abPending = !result.audiobookReady;
    if (result.courseReady) {
      lines.push({ icon: '🎉', text: _abPending
        ? 'El curso está listo aunque el audiolibro siga pendiente.'
        : 'El curso está listo y el paquete Moodle ya quedó guardado.' });
    } else if (result.mbzGenerated && !result.mbzStoredInCloud) {
      lines.push({ icon: '⚠️', text: 'Terminamos el paquete, pero no pudimos guardarlo todavía. Intenta nuevamente.' });
    } else if (result.mbzGenerated) {
      lines.push({ icon: '📦', text: 'Paquete Moodle generado. Descárgalo desde el panel de Descargas.' });
    } else if (result.videosRestored || result.contentRestored) {
      lines.push({ icon: '⏳', text: 'Puedes continuar cuando los videos estén listos.' });
    }

    return lines;
  }

  /** Acción del botón "Preparar curso": ejecuta el flujo y muestra resultados amigables. */
  async function runHybridFlowUI(courseIdOverride) {
    var courseId = courseIdOverride
                || (typeof window.ACTIVE_COURSE_ID !== 'undefined' && window.ACTIVE_COURSE_ID)
                || (typeof D !== 'undefined' && D && D.backendCourseId)
                || null;

    var ui = _getHybridUiEls();
    var btn = ui.btn;
    var result_el = ui.resultEl;

    if (!result_el) return;

    // Loading state
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Preparando…'; }
    if (!courseId) {
      result_el.innerHTML =
        '<div style="font-size:12px;color:rgba(176,110,10,.9);padding:6px 0;">' +
          '⚠️ Abre o selecciona un curso para prepararlo.' +
        '</div>';
      if (btn) { btn.disabled = false; btn.innerHTML = '🚀 Preparar curso'; }
      return;
    }

    if (!backendIsEnabled() && !window.SB_USER) {
      result_el.innerHTML =
        '<div style="font-size:12px;color:rgba(176,110,10,.9);padding:6px 0;">' +
          '⚠️ Activa la nube e inicia sesión para recuperar avances guardados.' +
        '</div>';
      if (btn) { btn.disabled = false; btn.innerHTML = '🚀 Preparar curso'; }
      return;
    }

    if (!backendIsEnabled()) {
      result_el.innerHTML =
        '<div style="font-size:12px;color:rgba(176,110,10,.9);padding:6px 0;">' +
          '⚠️ Activa la nube para recuperar avances guardados.' +
        '</div>';
      if (btn) { btn.disabled = false; btn.innerHTML = '🚀 Preparar curso'; }
      return;
    }

    if (!window.SB_USER) {
      result_el.innerHTML =
        '<div style="font-size:12px;color:rgba(176,110,10,.9);padding:6px 0;">' +
          '⚠️ Inicia sesión para recuperar avances guardados.' +
        '</div>';
      if (btn) { btn.disabled = false; btn.innerHTML = '🚀 Preparar curso'; }
      return;
    }

    result_el.innerHTML =
        '<div style="font-size:12px;color:rgba(3, 10, 38,.5);padding:6px 0;">Revisando lo que hay guardado en la nube…</div>';

    // Audiobook progress callback — updates DOM while TTS calls are in-flight
    function _onAudiobookProgress(prog) {
      if (!result_el) return;
      var progMsg = '';
      if (prog.status === 'generating_script') {
        progMsg = '🎙️ Preparando el guion del audiolibro…';
      } else if (prog.status === 'generating' || prog.status === 'chapter_done') {
        var pct = prog.total > 0 ? Math.round((prog.chapter / prog.total) * 100) : 0;
        progMsg = '🎙️ Generando audiolibro…' + (pct > 0 ? ' ' + pct + '%' : '');
      } else if (prog.status === 'merging') {
        progMsg = '🎙️ Uniendo audiolibro…';
      }
      if (progMsg) {
        var existing = result_el.querySelector('[data-role="audiobook-progress"]');
        if (!existing) {
          existing = document.createElement('div');
          existing.setAttribute('data-role', 'audiobook-progress');
          existing.style.cssText = 'font-size:12px;color:rgba(3, 10, 38,.5);padding:6px 0;display:flex;align-items:center;gap:6px;';
          result_el.appendChild(existing);
        }
        existing.textContent = progMsg;
      }
    }

    function _onStatus(status) {
      if (!result_el || !status || !status.message) return;
      var existing = result_el.querySelector('[data-role="hybrid-status"]');
      if (!existing) {
        existing = document.createElement('div');
        existing.setAttribute('data-role', 'hybrid-status');
        existing.style.cssText = 'font-size:12px;color:rgba(3, 10, 38,.5);padding:6px 0;';
        result_el.appendChild(existing);
      }
      existing.textContent = status.message;
    }

    var result;
    try {
      result = await runHybridBackendCourseFlow({
        courseId:            courseId,
        autoFinalize:        true,
        generateMbz:         true,
        skipDownload:        true,
        onAudiobookProgress: _onAudiobookProgress,
        onStatus:            _onStatus,
      });
    } catch (e) {
      result_el.innerHTML =
        '<div style="font-size:12px;color:#ef4444;padding:6px 0;">' +
          '❌ Ocurrió un error inesperado. Intenta de nuevo.' +
        '</div>';
      if (btn) { btn.disabled = false; btn.innerHTML = '🚀 Preparar curso'; }
      return;
    }

    // Render friendly messages
    var msgs = _hybridFriendlyMessages(result);
    var html = ['<div style="display:flex;flex-direction:column;gap:6px;margin-top:2px;">'];

    msgs.forEach(function (m) {
      var color = m.icon === '✅' || m.icon === '🎉' || m.icon === '📦'
        ? 'rgba(34,197,94,.85)'
        : m.icon === '⚠️' || m.icon === '❌'
        ? 'rgba(239,68,68,.85)'
        : m.icon === '⏳'
        ? 'rgba(248,181,0,.8)'
        : 'rgba(3, 10, 38,.45)';

      html.push(
        '<div style="display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.5;">' +
          '<span style="flex-shrink:0;">' + m.icon + '</span>' +
          '<span style="color:' + color + ';">' + _esc(m.text) + '</span>' +
        '</div>'
      );
    });

    // Audiobook download button — show when audiobook is ready in memory
    if (result.audiobookReady && window.MEDIA && window.MEDIA.audiolibro) {
      var _abMb = parseFloat(result.audiobookSizeMb || 0);
      var _abNote = _abMb > 30
        ? 'Es un archivo grande (' + result.audiobookSizeMb + ' MB) y no se incluye en el paquete Moodle.'
        : '';
      html.push(
        '<div style="margin-top:8px;padding:8px 12px;border-radius:8px;' +
          'background:rgba(96,165,250,.07);border:1px solid rgba(96,165,250,.18);">' +
          '<div style="font-size:12px;color:oklch(0.46 0.20 264.7);margin-bottom:6px;font-weight:600;">🎧 Audiolibro listo</div>' +
          (_abNote
            ? '<div style="font-size:11px;color:rgba(3, 10, 38,.5);margin-bottom:8px;">' + _esc(_abNote) + '</div>'
            : '') +
          '<button type="button" id="btn-download-audiobook"' +
            ' style="padding:6px 12px;border-radius:7px;border:1px solid rgba(96,165,250,.35);' +
            'background:rgba(96,165,250,.12);color:oklch(0.46 0.20 264.7);font-size:12px;font-weight:600;cursor:pointer;">' +
            '⬇️ Descargar audiolibro' +
          '</button>' +
        '</div>'
      );
    }

    // Next action pill (if actionable)
    if (result.courseReady) {
      html.push(
        '<div style="margin-top:8px;padding:8px 12px;border-radius:8px;' +
          'background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);' +
          'font-size:12px;color:var(--green);">' +
          '<div style="margin-bottom:8px;">El curso está listo. Puedes descargar el paquete Moodle cuando quieras.</div>' +
          '<button type="button" id="btn-download-moodle-package" style="padding:8px 14px;border-radius:8px;' +
            'border:1px solid rgba(34,197,94,.35);background:rgba(34,197,94,.12);color:var(--green);' +
            'font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">' +
            '⬇️ Descargar paquete Moodle' +
          '</button>' +
          '<div id="hybrid-package-result"></div>' +
        '</div>'
      );
    } else if (result.videoValidation && result.videoValidation.needsReconnect) {
      html.push(
        '<div style="margin-top:8px;padding:8px 12px;border-radius:8px;' +
          'background:rgba(248,181,0,.07);border:1px solid rgba(248,181,0,.15);' +
          'font-size:12px;color:rgba(176,110,10,.9);">' +
          '<div style="margin-bottom:8px;">Necesita reconectar YouTube para continuar con los videos pendientes.</div>' +
          '<button type="button" id="btn-hybrid-reconnect-youtube" style="padding:8px 14px;border-radius:8px;' +
            'border:1px solid rgba(248,181,0,.35);background:rgba(248,181,0,.12);color:rgba(176,110,10,.9);' +
            'font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">' +
            '🔗 Reconectar YouTube' +
          '</button>' +
        '</div>'
      );
    } else if (result.videoValidation && (result.videoValidation.quotaBlocked || result.videoValidation.retryPendingCount > 0 || result.videoValidation.downloadOnlyCount > 0)) {
      html.push(
        '<div style="margin-top:8px;padding:8px 12px;border-radius:8px;' +
          'background:rgba(248,181,0,.07);border:1px solid rgba(248,181,0,.15);' +
          'font-size:12px;color:rgba(176,110,10,.9);">' +
          '<div style="margin-bottom:8px;">' + _esc(
            result.videoValidation.quotaBlocked
              ? 'YouTube no permitió subir más videos por ahora. Puedes intentarlo más tarde.'
              : 'Faltan algunos videos. Puedes reintentar sin empezar desde cero.'
          ) + '</div>' +
          '<button type="button" id="btn-hybrid-retry-youtube" style="padding:8px 14px;border-radius:8px;' +
            'border:1px solid rgba(248,181,0,.35);background:rgba(248,181,0,.12);color:rgba(176,110,10,.9);' +
            'font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">' +
            '↻ Reintentar videos pendientes' +
          '</button>' +
        '</div>'
      );
    } else if (result.mbzGenerated && !result.mbzStoredInCloud) {
      html.push(
        '<div style="margin-top:8px;padding:8px 12px;border-radius:8px;' +
          'background:rgba(248,181,0,.07);border:1px solid rgba(248,181,0,.15);' +
          'font-size:12px;color:rgba(176,110,10,.9);">' +
          '⚠️ Terminamos el paquete, pero no pudimos guardarlo todavía. Intenta nuevamente en unos minutos.' +
        '</div>'
      );
    } else if (!result.videosRestored && !result.contentRestored) {
      html.push(
        '<div style="margin-top:8px;padding:8px 12px;border-radius:8px;' +
          'background:rgba(248,181,0,.07);border:1px solid rgba(248,181,0,.15);' +
          'font-size:12px;color:rgba(176,110,10,.9);">' +
          '💡 Los videos se generan en la nube. Espera a que el proceso automático los procese.' +
        '</div>'
      );
    }

    html.push('</div>');
    result_el.innerHTML = html.join('');
    if (result.courseReady || (result.videoValidation && !result.videoValidation.needsReconnect)) {
      _clearYoutubeReconnectResume();
    }
    _bindHybridPackageButton();
    _bindHybridRecoveryButtons(courseId);
    if (typeof _olbRefreshMbzArtifacts === 'function') {
      try { _olbRefreshMbzArtifacts(); } catch (e) {}
    }
    if (typeof olbRefreshCloud === 'function') {
      try { olbRefreshCloud(); } catch (e) {}
    }
    if (typeof _olbRefreshJobStates === 'function') {
      try { _olbRefreshJobStates(); } catch (e) {}
    }

    // Bind audiobook download button
    (function () {
      var abBtn = document.getElementById('btn-download-audiobook');
      if (!abBtn) return;
      abBtn.addEventListener('click', function () {
        if (!(window.MEDIA && window.MEDIA.audiolibro)) return;
        var url = URL.createObjectURL(window.MEDIA.audiolibro);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'audiolibro.mp3';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
      });
    })();

    // Restore button
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = result.courseReady ? '🔄 Volver a preparar' : '🚀 Preparar curso';
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Audio backend job — createBackendAudioJob, pollBackendAudioJob
  // ──────────────────────────────────────────────────────────────

  /**
   * Crea (o recupera) un job backend_audio en el servidor.
   * POST /api/v1/jobs/audio
   * Si ya existe un job activo para el curso, el endpoint devuelve ese job.
   *
   * @param {string} courseId
   * @param {{ courseData, bookExcerpts?, options?, metadata? }} payload
   * @returns {Promise<{ok, jobId?, job?, error?}>}
   */
  function createBackendAudioJob(courseId, payload) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId) return Promise.resolve({ ok: false, error: 'no_course_id' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });

    var body = Object.assign({ courseId: courseId }, payload || {});

    return backendApiRequest('/api/v1/jobs/audio', { method: 'POST', body: body })
      .then(function (res) {
        if (!res.ok) {
          var errMsg = (res.data && res.data.message) || res.error || 'create_failed';
          return { ok: false, error: errMsg };
        }
        var data = res.data || {};
        var job  = data.data || data;
        var jobId = job.jobId || job.id || null;
        console.log('[Cursia:audio-worker] Job backend_audio creado/recuperado:', jobId,
          'status:', job.workerStatus || job.status);
        return { ok: true, jobId: jobId, job: job };
      })
      .catch(function (e) {
        return { ok: false, error: e.message };
      });
  }

  /**
   * Retorna el último job backend_audio para el curso desde la lista de jobs.
   *
   * @param {string} [courseId]
   * @returns {Promise<{ok, job?, error?}>}
   */
  function getBackendAudioJobStatus(courseId) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId) return Promise.resolve({ ok: false, error: 'no_course_id' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });

    return jobList(courseId).then(function (res) {
      if (!res.ok || !res.data || !res.data.length) return { ok: false, error: 'no_jobs_found' };
      var audioJobs = res.data.filter(function (j) {
        return _jobField(j, 'execution_mode', 'executionMode') === 'backend_audio';
      });
      if (!audioJobs.length) return { ok: false, error: 'no_audio_jobs' };
      audioJobs.sort(function (a, b) {
        return new Date(_jobField(b, 'created_at', 'createdAt') || 0) -
               new Date(_jobField(a, 'created_at', 'createdAt') || 0);
      });
      return { ok: true, job: audioJobs[0] };
    }).catch(function (e) { return { ok: false, error: e.message }; });
  }

  /**
   * Polling del job backend_audio hasta que termine.
   *
   * @param {string} jobId
   * @param {function} onUpdate — fn({ job, workerStatus, progress, done, summary, error? })
   * @param {number} [intervalMs=5000]
   * @returns {{ stop: function }}
   */
  function pollBackendAudioJob(jobId, onUpdate, intervalMs) {
    if (!jobId || typeof onUpdate !== 'function') {
      return { stop: function () {} };
    }
    intervalMs = intervalMs || 5000;
    var MAX_ERRORS = 10;
    var stopped = false;
    var timer = null;
    var consecutiveErrors = 0;
    var TERMINAL = ['completed', 'failed', 'failed_recoverable', 'cancelled'];

    function _poll() {
      if (stopped) return;
      jobGet(jobId).then(function (res) {
        if (stopped) return;
        if (!res || !res.ok) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_ERRORS) {
            onUpdate({ job: null, workerStatus: 'unknown', progress: 0, done: true, error: 'polling_stopped_max_errors' });
            stopped = true;
          } else {
            timer = setTimeout(_poll, intervalMs * 2);
          }
          return;
        }
        consecutiveErrors = 0;
        var job = (res.data && res.data.data) ? res.data.data : (res.data || res.job || null);
        if (!job) { timer = setTimeout(_poll, intervalMs); return; }

        var workerStatus = _jobField(job, 'worker_status', 'workerStatus') || 'unknown';
        var progress     = _jobField(job, 'progress', 'progress') || 0;
        var summary      = _jobField(job, 'output_summary', 'outputSummary') || {};
        var done         = TERMINAL.indexOf(workerStatus) >= 0;

        onUpdate({ job: job, workerStatus: workerStatus, progress: progress, summary: summary, done: done });

        if (!done) {
          timer = setTimeout(_poll, intervalMs);
        } else {
          stopped = true;
        }
      }).catch(function (e) {
        consecutiveErrors++;
        if (!stopped && consecutiveErrors < MAX_ERRORS) timer = setTimeout(_poll, intervalMs * 2);
      });
    }

    timer = setTimeout(_poll, 500);
    return {
      stop: function () {
        stopped = true;
        if (timer) clearTimeout(timer);
      }
    };
  }

  /**
   * Descarga los artifacts audio_welcome y audiobook del job completado
   * y los pone en MEDIA.audio / MEDIA.audiolibro.
   *
   * @param {object} summary — outputSummary del job
   * @returns {Promise<{ welcome: boolean, audiobook: boolean }>}
   */
  function restoreAudioFromJobSummary(summary) {
    var result = { welcome: false, audiobook: false };
    if (!summary || typeof artifactDownloadUrl !== 'function') return Promise.resolve(result);

    function _downloadArtifact(artifactId, mediaKey) {
      if (!artifactId) return Promise.resolve(false);
      return artifactDownloadUrl(artifactId).then(function (urlRes) {
        var url = urlRes && urlRes.url;
        if (!url) return false;
        return fetch(url).then(function (r) {
          if (!r.ok) return false;
          return r.blob().then(function (blob) {
            if (!blob || !blob.size) return false;
            window.MEDIA = window.MEDIA || { audio: null, audiolibro: null, videos: {} };
            window.MEDIA[mediaKey] = blob;
            if (typeof handleMediaFile === 'function') handleMediaFile(blob, mediaKey);
            return true;
          });
        });
      }).catch(function () { return false; });
    }

    var welcomeId   = summary.welcomeAudio && summary.welcomeAudio.artifactId;
    var audiobookId = summary.audiobook && summary.audiobook.artifactId;

    return _downloadArtifact(welcomeId, 'audio').then(function (ok) {
      result.welcome = !!ok;
      return _downloadArtifact(audiobookId, 'audiolibro');
    }).then(function (ok) {
      result.audiobook = !!ok;
      return result;
    }).catch(function () { return result; });
  }

  window.createBackendVideoJob                 = createBackendVideoJob;
  window.getBackendVideoJobStatus              = getBackendVideoJobStatus;
  window.restoreBackendVideoResultsFromJob     = restoreBackendVideoResultsFromJob;
  window.restoreBackendVideoResultsFromCloud   = restoreBackendVideoResultsFromCloud;
  window.validateRestoredVideosForH5P          = validateRestoredVideosForH5P;
  window.generateH5PFromRestoredVideos         = generateH5PFromRestoredVideos;
  window.validateRestoredH5PForMbz             = validateRestoredH5PForMbz;
  window.uploadH5PSnapshotArtifact             = uploadH5PSnapshotArtifact;
  window.restoreH5PSnapshotFromCloud           = restoreH5PSnapshotFromCloud;
  window.runHybridBackendCourseFlow            = runHybridBackendCourseFlow;
  window.runHybridFlowUI                       = runHybridFlowUI;
  window.resumeHybridFlowAfterYoutubeReconnect = resumeHybridFlowAfterYoutubeReconnect;
  window.clearYoutubeReconnectResume           = _clearYoutubeReconnectResume;
  window.requeueBackendVideoJob                = requeueBackendVideoJob;
  window.downloadPreparedMoodlePackage         = downloadPreparedMoodlePackage;
  // ──────────────────────────────────────────────────────────────
  // Package backend job — createBackendPackageJob, pollBackendPackageJob
  // ──────────────────────────────────────────────────────────────

  /**
   * Crea (o recupera) un job backend_package en el servidor.
   * POST /api/v1/jobs/package
   *
   * @param {string} courseId
   * @param {{ contentSnapshotArtifactId, h5pSnapshotArtifactId?, audioWelcomeArtifactId?, audiobookArtifactId?, options? }} payload
   * @returns {Promise<{ok, jobId?, job?, error?}>}
   */
  /**
   * Crea (o recupera) un job backend_gamma — presentaciones Gamma por capítulo.
   * Fire-and-forget: no es un paso oficial del pipeline local, solo visibilidad en logs.
   */
  function createBackendGammaJob(courseId, payload) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId) return Promise.resolve({ ok: false, error: 'no_course_id' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });

    var body = Object.assign({ courseId: courseId }, payload || {});

    return backendApiRequest('/api/v1/jobs/gamma', { method: 'POST', body: body })
      .then(function (res) {
        if (!res.ok) {
          var errMsg = (res.data && res.data.message) || res.error || 'create_failed';
          return { ok: false, error: errMsg };
        }
        var data  = res.data || {};
        var job   = data.data || data;
        var jobId = job.jobId || job.id || null;
        console.log('[Cursia:gamma-worker] Job backend_gamma creado/recuperado:', jobId,
          'status:', job.workerStatus || job.status);
        return { ok: true, jobId: jobId, job: job };
      })
      .catch(function (e) { return { ok: false, error: e.message }; });
  }

  /**
   * Polling del job backend_gamma hasta que termine.
   * onUpdate({ job, workerStatus, progress, summary, done })
   */
  function pollBackendGammaJob(jobId, onUpdate, intervalMs) {
    if (!jobId || typeof onUpdate !== 'function') return { stop: function () {} };
    intervalMs = intervalMs || 8000;
    var MAX_ERRORS = 10;
    var stopped    = false;
    var timer      = null;
    var consecutiveErrors = 0;
    var TERMINAL = ['completed', 'failed', 'failed_recoverable', 'failed_retryable', 'cancelled'];

    function _poll() {
      if (stopped) return;
      jobGet(jobId).then(function (res) {
        if (stopped) return;
        if (!res || !res.ok) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_ERRORS) {
            onUpdate({ job:null, workerStatus:'unknown', progress:0, done:true, error:'polling_stopped_max_errors' });
            stopped = true;
          } else {
            timer = setTimeout(_poll, intervalMs * 2);
          }
          return;
        }
        consecutiveErrors = 0;
        var job = (res.data && res.data.data) ? res.data.data : (res.data || res.job || null);
        if (!job) { timer = setTimeout(_poll, intervalMs); return; }
        var ws       = job.worker_status || job.workerStatus || 'unknown';
        var progress = job.progress || 0;
        var summary  = job.output_summary || job.outputSummary || {};
        var done     = TERMINAL.indexOf(ws) >= 0;
        onUpdate({ job: job, workerStatus: ws, progress: progress, summary: summary, done: done });
        if (!done) timer = setTimeout(_poll, intervalMs);
        else stopped = true;
      }).catch(function () {
        consecutiveErrors++;
        if (!stopped && consecutiveErrors < MAX_ERRORS) timer = setTimeout(_poll, intervalMs * 2);
      });
    }

    timer = setTimeout(_poll, 500);
    return { stop: function () { stopped = true; if (timer) clearTimeout(timer); } };
  }

  function createBackendPackageJob(courseId, payload) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId) return Promise.resolve({ ok: false, error: 'no_course_id' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });

    var body = Object.assign({ courseId: courseId }, payload || {});

    return backendApiRequest('/api/v1/jobs/package', { method: 'POST', body: body })
      .then(function (res) {
        if (!res.ok) {
          var errMsg = (res.data && res.data.message) || res.error || 'create_failed';
          return { ok: false, error: errMsg };
        }
        var data  = res.data || {};
        var job   = data.data || data;
        var jobId = job.jobId || job.id || null;
        console.log('[Cursia:package-worker] Job backend_package creado/recuperado:', jobId,
          'status:', job.workerStatus || job.status);
        return { ok: true, jobId: jobId, job: job };
      })
      .catch(function (e) { return { ok: false, error: e.message }; });
  }

  /**
   * Estado del último backend_package job para el curso.
   */
  function getBackendPackageJobStatus(courseId) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId) return Promise.resolve({ ok: false, error: 'no_course_id' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });

    return jobList(courseId).then(function (res) {
      if (!res.ok || !res.data || !res.data.length) return { ok: false, error: 'no_jobs_found' };
      var pkgJobs = res.data.filter(function (j) {
        return (j.execution_mode || j.executionMode) === 'backend_package';
      });
      if (!pkgJobs.length) return { ok: false, error: 'no_package_jobs' };
      pkgJobs.sort(function (a, b) {
        return new Date((b.created_at || b.createdAt || 0)) - new Date((a.created_at || a.createdAt || 0));
      });
      return { ok: true, job: pkgJobs[0] };
    }).catch(function (e) { return { ok: false, error: e.message }; });
  }

  /**
   * Polling del job backend_package hasta que termine.
   * onUpdate({ job, workerStatus, progress, summary, done })
   */
  function pollBackendPackageJob(jobId, onUpdate, intervalMs) {
    if (!jobId || typeof onUpdate !== 'function') return { stop: function () {} };
    intervalMs = intervalMs || 8000;
    var MAX_ERRORS = 10;
    var stopped    = false;
    var timer      = null;
    var consecutiveErrors = 0;
    var TERMINAL = ['completed', 'failed', 'failed_recoverable', 'cancelled'];

    function _poll() {
      if (stopped) return;
      jobGet(jobId).then(function (res) {
        if (stopped) return;
        if (!res || !res.ok) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_ERRORS) {
            onUpdate({ job:null, workerStatus:'unknown', progress:0, done:true, error:'polling_stopped_max_errors' });
            stopped = true;
          } else {
            timer = setTimeout(_poll, intervalMs * 2);
          }
          return;
        }
        consecutiveErrors = 0;
        var job = (res.data && res.data.data) ? res.data.data : (res.data || res.job || null);
        if (!job) { timer = setTimeout(_poll, intervalMs); return; }
        var ws       = job.worker_status || job.workerStatus || 'unknown';
        var progress = job.progress || 0;
        var summary  = job.output_summary || job.outputSummary || {};
        var done     = TERMINAL.indexOf(ws) >= 0;
        onUpdate({ job: job, workerStatus: ws, progress: progress, summary: summary, done: done });
        if (!done) timer = setTimeout(_poll, intervalMs);
        else stopped = true;
      }).catch(function () {
        consecutiveErrors++;
        if (!stopped && consecutiveErrors < MAX_ERRORS) timer = setTimeout(_poll, intervalMs * 2);
      });
    }

    timer = setTimeout(_poll, 500);
    return { stop: function () { stopped = true; if (timer) clearTimeout(timer); } };
  }

  /**
   * Lee el artifactId del mbz_final del outputSummary del job y devuelve una URL de descarga.
   * @param {object} summary — outputSummary del job backend_package completado
   * @returns {Promise<{ ok, artifactId?, downloadUrl?, filename?, sizeBytes? }>}
   */
  function getMbzFinalFromJobSummary(summary) {
    var mbzInfo = summary && summary.mbzFinal;
    if (!mbzInfo || !mbzInfo.artifactId) return Promise.resolve({ ok: false, error: 'no_artifact' });
    if (typeof artifactDownloadUrl !== 'function') return Promise.resolve({ ok: false, error: 'artifact_fn_missing' });

    return artifactDownloadUrl(mbzInfo.artifactId).then(function (urlRes) {
      if (!urlRes || !urlRes.url) return { ok: false, error: 'no_url' };
      return {
        ok: true,
        artifactId:  mbzInfo.artifactId,
        downloadUrl: urlRes.url,
        filename:    mbzInfo.filename || 'curso_moodle.mbz',
        sizeBytes:   mbzInfo.sizeBytes || null,
      };
    }).catch(function (e) { return { ok: false, error: e && e.message || 'url_error' }; });
  }

  window.createBackendAudioJob                 = createBackendAudioJob;
  window.getBackendAudioJobStatus              = getBackendAudioJobStatus;
  window.pollBackendAudioJob                   = pollBackendAudioJob;
  window.restoreAudioFromJobSummary            = restoreAudioFromJobSummary;
  window.createBackendGammaJob                 = createBackendGammaJob;
  window.pollBackendGammaJob                   = pollBackendGammaJob;
  window.createBackendPackageJob               = createBackendPackageJob;
  window.getBackendPackageJobStatus            = getBackendPackageJobStatus;
  window.pollBackendPackageJob                 = pollBackendPackageJob;
  window.getMbzFinalFromJobSummary             = getMbzFinalFromJobSummary;

  // ──────────────────────────────────────────────────────────────
  // Fase 12 — Full Course Backend Orchestrator
  // POST /api/v1/jobs/full — crea o reanuda el job maestro.
  // El full-course-worker coordina todos los pasos en el servidor.
  // ──────────────────────────────────────────────────────────────

  /**
   * Crea o reanuda un job maestro course_full_generation en el backend.
   * Idempotente: si ya hay uno activo para el curso, lo devuelve.
   *
   * @param {string} courseId
   * @param {{ courseData?, options?, metadata? }} payload
   * @returns {Promise<{ok, jobId?, resumed?, status?, workerStatus?, error?}>}
   */
  function createFullCourseJobBackend(courseId, payload) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId) return Promise.resolve({ ok: false, error: 'no_course_id' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });

    var body = Object.assign({ courseId: courseId }, payload || {});

    // 30 s — Supabase puede tardar varios segundos en cold start; el endpoint solo hace
    // una consulta + un INSERT, pero la conexión inicial puede tardar más de 8 s.
    return backendApiRequest('/api/v1/jobs/full', { method: 'POST', body: body }, 30000)
      .then(function (res) {
        if (!res.ok) {
          var errMsg = (res.data && res.data.message) || res.error || 'create_failed';
          return { ok: false, error: errMsg };
        }
        var data = res.data || {};
        var jobId = data.jobId || data.id || null;
        console.log('[Cursia:full-course] Job maestro', data.resumed ? 'retomado' : 'creado', ':', jobId, '(status=' + data.workerStatus + ')');
        return { ok: true, jobId: jobId, resumed: !!data.resumed, status: data.status, workerStatus: data.workerStatus };
      })
      .catch(function (e) {
        return { ok: false, error: e && e.message || 'unknown' };
      });
  }

  /**
   * Obtiene el estado actual del job maestro course_full_generation.
   * Usa el endpoint existente GET /api/v1/jobs/:id.
   *
   * El ResponseInterceptor de NestJS añade una capa extra:
   *   HTTP JSON → { data: { ok, data: entity }, timestamp }
   *   _fetchWithTimeout pela → res.data = { ok, data: entity }
   * Por eso usamos payload.data || payload para llegar a la entidad real.
   *
   * @param {string} jobId
   * @returns {Promise<{ok, job?, error?}>}
   */
  function getFullCourseJobState(jobId) {
    if (!jobId) return Promise.resolve({ ok: false, error: 'no_job_id' });
    return jobGet(jobId).then(function (res) {
      if (!res.ok) return { ok: false, error: res.error || 'fetch_failed' };
      // ResponseInterceptor wrap: res.data = { ok: true, data: <entity> }
      var payload = res.data || {};
      var job = payload.data || payload;
      if (!job || typeof job !== 'object' || !job.id) {
        // Intentar un nivel más arriba (por si viene sin doble-wrap)
        job = payload;
      }
      return { ok: true, job: job };
    });
  }

  /**
   * Reintenta el job maestro course_full_generation después de un fallo recuperable,
   * reconexión YouTube o reset de cuota.
   * Conserva el outputSummary para restore-first.
   *
   * @param {string} jobId
   * @returns {Promise<{ok, error?}>}
   */
  function retryFullCourseJob(jobId) {
    if (!jobId) return Promise.resolve({ ok: false, error: 'no_job_id' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });
    return backendApiRequest('/api/v1/jobs/' + jobId + '/retry', { method: 'POST', body: {} })
      .then(function (res) {
        if (!res.ok) return { ok: false, error: (res.data && res.data.reason) || res.error || 'retry_failed' };
        return { ok: true };
      });
  }

  function cancelFullCourseJob(jobId, reason) {
    if (!jobId) return Promise.resolve({ ok: false, error: 'no_job_id' });
    if (!backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false, error: 'backend_off' });
    return backendApiRequest('/api/v1/jobs/' + jobId + '/cancel', {
      method: 'POST',
      body: { reason: reason || 'user_cancelled' }
    }).then(function (res) {
      if (!res.ok) {
        return { ok: false, error: (res.data && res.data.message) || res.error || 'cancel_failed' };
      }
      return { ok: true, data: res.data || {} };
    }).catch(function (e) {
      return { ok: false, error: e && e.message || 'unknown' };
    });
  }

  /**
   * Busca el job maestro course_full_generation más reciente para el curso.
   * Cubre tanto los jobs nuevos (execution_mode='course_full_generation' con workerStatus)
   * como los legacy (execution_mode='frontend' con options.executionMode='course_full_generation').
   *
   * @param {string} courseId
   * @returns {Promise<{ok, job?}>}
   */
  function findActiveFullCourseJob(courseId) {
    courseId = courseId || window.ACTIVE_COURSE_ID;
    if (!courseId || !backendIsEnabled() || !window.SB_USER) return Promise.resolve({ ok: false });

    return jobList(courseId).then(function (res) {
      if (!res.ok || !Array.isArray(res.data) || !res.data.length) return { ok: false };

      var ACTIVE = ['queued', 'running', 'retrying', 'needs_reconnect', 'blocked_quota'];

      // Look for new-style orchestrator jobs first (execution_mode = 'course_full_generation')
      var orchestratorJobs = res.data.filter(function (j) {
        var em = j.execution_mode || j.executionMode || '';
        var ws = j.worker_status  || j.workerStatus  || j.status || '';
        return em === 'course_full_generation' && ACTIVE.indexOf(ws) !== -1;
      });

      // Sort by most recent
      orchestratorJobs.sort(function (a, b) {
        return new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0);
      });

      if (orchestratorJobs.length) {
        return { ok: true, job: orchestratorJobs[0], isOrchestrator: true };
      }

      return { ok: false };
    });
  }

  window.createFullCourseJobBackend            = createFullCourseJobBackend;
  window.getFullCourseJobState                 = getFullCourseJobState;
  window.retryFullCourseJob                    = retryFullCourseJob;
  window.cancelFullCourseJob                   = cancelFullCourseJob;
  window.findActiveFullCourseJob               = findActiveFullCourseJob;

  // ──────────────────────────────────────────────────────────────
  // Enganche con go() — renderizar panel al navegar hacia él
  // ──────────────────────────────────────────────────────────────
  (function _hookGo() {
    function _attachHook() {
      if (typeof go !== 'function') return;
      var _origGoBackend = go;
      go = function (id) {
        if (id === 'backend' && !_canAccessBackendPanel()) {
          _origGoBackend('cuenta');
          return;
        }
        _origGoBackend(id);
        if (id === 'backend') {
          setTimeout(_renderBackendPanel, 30);
          _updateBackendSidebarBadge();
        } else if (id === 'produccion') {
          setTimeout(_renderHybridProductionAction, 30);
        }
      };
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _attachHook);
    } else {
      _attachHook();
    }
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(_renderHybridProductionAction, 80);
    });
  } else {
    setTimeout(_renderHybridProductionAction, 80);
  }

  // Feature flag V2: si 20-supabase.js ya activó la sesión antes de que este
  // archivo cargara, evaluar ahora (si no, lo dispara activateSession).
  try { if (window.SB_USER) cursiaV2FeaturesRefresh(); } catch (e) {}

})();
