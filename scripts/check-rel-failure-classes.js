#!/usr/bin/env node
/* eslint-disable */
// REL R1 — clasificador central de fallos (src/modules/reliability/failure-classifier.ts).
//
// Puro (sin DB, sin red):
//   1. tabla del diseño §3.2: mensajes reales → clase / código / estrategia / scope / riesgo de pago;
//   2. reglas: errorCode explícito gana; desconocido → A ×1 (`unclassified`); nunca lanza;
//   3. paso que preserva el comportamiento: las reglas del auto-healer y del reintento seguro son
//      las MISMAS (re-exportadas), y `currentRecoveryOf` coincide con autoHealDecision/safeAutoRetryDecision;
//   4. GATE: cada código que el backend EMITE hoy (failItem / fail(deps / applyItemFailure /
//      failJob / blockItemForBudget, resueltos desde el código fuente) tiene una regla EXPLÍCITA;
//      cada código interno de validación y de empaque también. Un emisor nuevo sin resolver o un
//      código nuevo sin regla → el check falla;
//   5. (con --fe <dir del frontend>) lo mismo para el ejecutor del navegador
//      (45-dynamic-generation-executor.js + 04-api.js). Sin --fe se omite (el frontend es otro repo).
//
// Uso: npm run build && node scripts/check-rel-failure-classes.js [--fe ../campuscloud-gen] [path/to/dist]

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const feIdx = args.indexOf('--fe');
const FE_DIR = feIdx >= 0 ? path.resolve(args[feIdx + 1]) : (process.env.REL_FE_DIR ? path.resolve(process.env.REL_FE_DIR) : null);
const distArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--fe');
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');

function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

const FC = loadDist('modules/reliability/failure-classifier.js');
const RULES = loadDist('modules/reliability/auto-heal-rules.js');
const AH = loadDist('modules/dynamic-generation/auto-heal.js');
const SCAN = require('./lib/rel-error-emitters');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.message ? err.message.split('\n').slice(0, 40).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }

const v = (error, extra = {}) => FC.classifyFailure({ error, ...extra });
function expectVerdict(error, want, extra = {}) {
  const got = v(error, extra);
  for (const [k, val] of Object.entries(want)) {
    const g = got[k];
    const ok = Array.isArray(val) ? JSON.stringify(g) === JSON.stringify(val) : g === val;
    if (!ok) throw new Error(`«${String(error).slice(0, 90)}» ${k}: esperado ${JSON.stringify(val)}, encontrado ${JSON.stringify(g)} (regla ${got.rule})`);
  }
  assert(got.unclassified === false || want.unclassified === true, `«${error}» quedó sin clasificar (${got.code})`);
  return got;
}

const GAMMA = { external: { gammaGenerationId: 'gen_1' } };
const VG = { external: { videogenJobId: 'vg_1' } };

// ════════════════════════════════════════════════════════════════════════════
// 1. Tabla (diseño §3.2)
// ════════════════════════════════════════════════════════════════════════════
check('tabla: infraestructura, lease y transporte', () => {
  expectVerdict('lease_expired', { class: 'A', code: 'lease_expired', strategy: 'retry_backoff', scope: 'item' });
  expectVerdict('worker_draining: el worker se reinicia (deploy/parada ordenada) y devolvió el item x', { class: 'A', code: 'worker_draining' });
  expectVerdict('unexpected_error: Connection terminated', { class: 'A', code: 'unexpected_error', targetRounds: 3 });
  expectVerdict('unknown_error', { class: 'A', code: 'unknown_error', targetRounds: 1 });
  for (const m of ['content_download_failed: HTTP 503', 'dependency_download_failed: dynamic_content_md de x (HTTP 502)',
    'gamma_pdf_download_failed: HTTP 500 (se reintenta sin reenviar)', 'course_plan_download_failed: desconocido',
    'dynamic_content_md_download_failed: timeout', 'text_fetch_failed', 'download_url_failed', 'sign_failed']) {
    const r = v(m, { outputSummary: GAMMA });
    assert(r.class === 'A' && !r.unclassified, `${m}: ${JSON.stringify(r)}`);
  }
  expectVerdict('EXAM_BANK_CHAPTER_MD_MISSING: no se pudo leer el texto del capítulo c1 (HTTP 503)', { class: 'A', strategy: 'retry_backoff' });
  expectVerdict('EXAM_BANK_CHAPTER_MD_MISSING: el capítulo c1 llegó con 2 artifacts dynamic_content_md (se esperaba 1)', { class: 'D', humanReason: 'product_bug' });
  expectVerdict('no se pudo subir el artifact dynamic_content_md: HTTP 500', { class: 'A', code: 'artifact_upload_failed' });
  expectVerdict('complete rechazado: missing_required_artifacts', { class: 'A', code: 'complete_rejected', targetRounds: 1 });
  expectVerdict('finops_unavailable: ledger caído', { class: 'A', strategy: 'wait_provider', scope: 'run' });
});

check('tabla: IA (transitorios A, configuración D scope provider, tamaño/truncado B, presupuesto D)', () => {
  expectVerdict('❌ Falló después de 3 intentos: HTTP 529 overloaded', { class: 'A', code: 'browser_llm_transient', paidRisk: 'measured', provider: 'anthropic' });
  expectVerdict('Falló después de 5 intentos: fetch failed', { class: 'A', code: 'browser_llm_transient' });
  expectVerdict('Servidor ocupado (529). Reintentando…', { class: 'A', code: 'llm_transient', httpStatus: 529 });
  expectVerdict('Error del servidor (500). Reintentando…', { class: 'A', code: 'llm_transient' });
  expectVerdict('Error de red: Failed to fetch', { class: 'A', code: 'llm_transient' });
  expectVerdict('Respuesta vacía de la API', { class: 'A', code: 'llm_empty_response' });
  expectVerdict('❌ Sin disponibilidad de generación. Contacta a soporte de Cursia.', { class: 'D', scope: 'provider', strategy: 'wait_provider', humanReason: 'config', code: 'llm_credit_exhausted' });
  expectVerdict('❌ El servicio de IA de este entorno no está configurado. Contacta a soporte de Cursia.', { class: 'D', code: 'proxy_misconfigured', scope: 'provider' });
  expectVerdict('❌ Error de configuración interna. Intenta nuevamente o contacta soporte.', { class: 'D', code: 'llm_model_config' });
  expectVerdict('❌ No tienes acceso. Inicia sesión o verifica tu cuenta en Cursia.', { class: 'A', code: 'browser_auth' });
  expectVerdict('Petición demasiado grande (413)', { class: 'B', strategy: 'regenerate_split' });
  expectVerdict('EXAM_BANK_PROMPT_TOO_LARGE: el texto del capítulo c1 supera el tope', { class: 'B', strategy: 'regenerate_split' });
  expectVerdict('❌ Error al procesar la solicitud: prompt is too long: 210000 tokens', { class: 'B', strategy: 'regenerate_split', code: 'llm_request_rejected' });
  expectVerdict('❌ Error al procesar la solicitud: messages.0.content: invalid', { class: 'D', humanReason: 'product_bug' });
  for (const m of ['CONTENT_TRUNCATED_MAX_TOKENS: el capítulo superó el tope de salida (8000)', 'CONTENT_TRUNCATED: falta el cierre',
    'OUTPUT_TRUNCATED_MAX_TOKENS: activity inválido tras reintento dirigido: H5P_INPUT_INVALID', 'respuesta truncada (stop_reason=max_tokens)']) {
    expectVerdict(m, { class: 'B', strategy: 'regenerate_split', targetRounds: 2 });
  }
  for (const m of ['budget_exceeded: el envío superaría el presupuesto', 'budget_approval_required', 'budget_blocked: política']) {
    expectVerdict(m, { class: 'D', strategy: 'hold_for_human', humanReason: 'budget', adminAction: 'approve_budget' });
  }
  // Sin código reconocible: el status HTTP decide.
  expectVerdict('upstream said no (HTTP 503)', { class: 'A', code: 'llm_transient', httpStatus: 503 });
  expectVerdict('algo raro', { class: 'A', code: 'llm_transient' }, { httpStatus: 524 });
});

check('tabla: validación (B, regenerar solo el componente; códigos internos expuestos)', () => {
  const r = expectVerdict('v3_payload_invalid: activity activity:c1 rechazado por el validador del servidor [BS_UNREACHABLE, TEXT_EMPTY] $.x BS_UNREACHABLE: nodo', {
    class: 'B', code: 'v3_payload_invalid', strategy: 'regenerate_targeted', targetRounds: 2,
  });
  assert(JSON.stringify(r.innerCodes) === JSON.stringify(['BS_UNREACHABLE', 'TEXT_EMPTY']), 'innerCodes ' + JSON.stringify(r.innerCodes));
  for (const m of ['activity inválido tras reintento dirigido: falta X', 'experience inválido tras reintento dirigido: TEXT_EMPTY',
    'plan de conceptos inválido tras reintento dirigido: x', 'plan de conceptos fusionado inválido: x', 'SCORM v2 inválido: sala 3',
    'contenido vacío tras generación', 'GIFT incompleto tras corrección: faltan 2', 'GIFT del examen final inválido: x',
    'JSON inválido', 'falta la lista "questions"', 'CONTENT_TRUTH: persisten 2', 'CONTENT_TRUTH_RETRY_INVALID: x',
    'EXAM_NEUROMYTH: respuestas correctas apoyadas en un neuromito', 'GIFT_NO_QUESTIONS', 'EXAM_BANK_INCOMPLETE: faltan 3',
    'EXAM_BANK_GENERATION_FAILED: la parte 2/3 falló dos veces', 'EXAM_BANK_PLAN: el plan del claim no coincide', 'AUDIOBOOK_SCRIPT_TOO_SHORT: 120 palabras']) {
    expectVerdict(m, { class: 'B' });
  }
  expectVerdict('EXAM_BANK_CLAIM: el claim no trae examBank válido para scope module', { class: 'D' });
  for (const m of ['context_package_failed: x', 'context_package_invalid_json: x', 'dynamic_content_md_empty: el artifact a está vacío',
    'course_plan_invalid: el plan del run no calza', 'AUDIO_SCRIPT_EMPTY: sin texto', 'AUDIOBOOK_CONTENT_EMPTY: x', 'AUDIO_WELCOME_TEXT_MISSING: x']) {
    expectVerdict(m, { class: 'B', strategy: 'regenerate_dependency' });
  }
  for (const m of ['presentation_artifact_invalid: SLIDE_COUNT, PDF_MISSING', 'gamma_pdf_invalid: x', 'gamma_generation_failed: x']) {
    expectVerdict(m, { class: 'B', strategy: 'regenerate_targeted', provider: 'gamma' });
  }
  expectVerdict('TTS_AUDIO_INVALID: el chunk 2/3 no es un MP3 medible', { class: 'B', provider: 'openai' });
  for (const c of ['BS_UNREACHABLE', 'TEXT_EMPTY', 'DIAGRAM_SHAPE', 'EXAM_BANK_DISTRACTORS', 'H5P_INPUT_INVALID', 'WORD_RANGE', 'GIFT_EMPTY']) {
    assert(FC.isKnownValidationCode(c), `${c} no es un código de validación conocido`);
  }
});

check('tabla: contrato y producto (D) — incluido el «ambiguous_*_artifact» de dependencias (no es un pago)', () => {
  for (const m of ['missing_course_plan_artifact: el item x', 'ambiguous_course_plan_artifact: 2 artifacts', 'missing_dynamic_content_md_artifact: el item x',
    'ambiguous_dynamic_content_md_artifact: el item x recibió 2', 'missing_dependency_artifact: x', 'missing_content_artifact',
    'claim_payload_unavailable: falta x', 'tipo no soportado por el ejecutor del navegador (v3): foo', 'rulesVersion no soportado por el ejecutor del navegador: 9',
    'video_interactions: VIDEO_PLAN_MISMATCH — los checkpoints', 'video_interactions: el claim no trae la duración', 'activity: variant desconocido o ausente (x)',
    'activity h5p: el claim no trae el tipo h5p requerido (contrato R11a)', 'ACTIVITY_TYPE_NOT_IN_MANIFEST: el tipo "x"', 'course_plan: el outline del claim no tiene capítulos',
    'video_duration_unmeasurable: el MP4 del video x', 'provider_worker_wrong_type: content', 'missing_artifact_id', 'artifact_download_unavailable']) {
    expectVerdict(m, { class: 'D', strategy: 'hold_for_human', humanReason: 'product_bug' });
  }
  expectVerdict('video_interactions: VIDEO_REFLECTION_PLAN_MISMATCH: las pausas', { class: 'D', code: 'VIDEO_REFLECTION_PLAN_MISMATCH' });
  for (const m of ['v3_validator_unavailable', 'v3_artifact_unreadable: x', 'V3_VALIDATION_CONTEXT: x']) expectVerdict(m, { class: 'A', targetRounds: 2 });
});

check('tabla: video (Videogen) — re-poll A, rechazo probado A ×1, ambiguo/fallido C (nunca reenvío ciego), configuración D', () => {
  expectVerdict('video_timeout', { class: 'A', strategy: 'repoll_external', provider: 'videogen' }, { outputSummary: VG });
  expectVerdict('video_timeout', { class: 'A', strategy: 'retry_backoff' }, { outputSummary: {} });
  expectVerdict('video_duration_unmeasured: el video video:c1 terminó sin duración', { class: 'A', strategy: 'repoll_external' }, { outputSummary: VG });
  expectVerdict('videogen_submit_rejected: Videogen rechazó (HTTP 422)', { class: 'A', targetRounds: 1 });
  for (const m of ['ambiguous_video_submission', 'ambiguous_video_submission: timeout del batchCreate', 'video_upgrade_ambiguous_submission', 'reserved_without_submit_marker']) {
    expectVerdict(m, { class: 'C', strategy: 'provider_check', paidRisk: 'uncertain', adminAction: 'reconcile_videogen', humanReason: 'duplicate_charge' });
  }
  expectVerdict('videogen_failed: el render falló', { class: 'C', strategy: 'hold_for_human', adminAction: 'retry_video_render', paidRisk: 'uncertain' });
  for (const m of ['videogen_not_configured', 'real_video_not_allowed: El video real ya no está habilitado', 'PROVIDER_MODE_UNSET: el run x',
    'provider_mock_not_allowed: el run x', 'provider_not_ready: el item x necesita GAMMA_API_KEY', 'video_delivery_not_youtube: la entrega directa',
    'theme_resolution_failed: x', 'GAMMA_COVER_RASTERIZER_UNAVAILABLE: pdftoppm no está instalado']) {
    expectVerdict(m, { class: 'D', humanReason: 'config' });
  }
});

check('tabla: YouTube, Gamma y TTS', () => {
  expectVerdict('youtube_upload_failed: YouTube respondió con un error temporal (HTTP 503)', { class: 'A', provider: 'youtube' });
  expectVerdict('youtube_blocked_quota: cuota diaria agotada', { class: 'A', strategy: 'wait_provider', scope: 'provider' });
  for (const m of ['youtube_blocked_auth: token revocado', 'youtube_preflight_failed: x', 'youtube_publisher_not_configured']) {
    expectVerdict(m, { class: 'D', humanReason: 'config', adminAction: 'resolve_youtube', scope: 'provider' });
  }
  expectVerdict('ambiguous_youtube_upload: x', { class: 'C', strategy: 'provider_check', paidRisk: 'none' });
  expectVerdict('youtube_invalid_url: x', { class: 'A', strategy: 'repoll_external' });
  for (const m of ['youtube_delivery_without_videogen_job', 'youtube_missing_videogen_download_url', 'invalid_video_delivery: x']) {
    expectVerdict(m, { class: 'B', strategy: 'regenerate_dependency' });
  }
  for (const m of ['gamma_timeout: la generación gen_1 no terminó', 'gamma_poll_failed: gamma: GET 503', 'gamma_export_missing: sin exportUrl']) {
    expectVerdict(m, { class: 'A', strategy: 'repoll_external', provider: 'gamma' }, { outputSummary: GAMMA });
  }
  expectVerdict('gamma_submit_failed: 400', { class: 'A', targetRounds: 1 });
  expectVerdict('gamma_submit_ambiguous: timeout', { class: 'C', paidRisk: 'uncertain', adminAction: 'reconcile_provider' });
  expectVerdict('tts_failed: chunk 1/4: HTTP 503', { class: 'A', strategy: 'retry_backoff', provider: 'openai' });
  expectVerdict('tts_failed: chunk 3/4: HTTP 503', { class: 'C', strategy: 'auto_resubmit_once', adminAction: 'reconcile_provider' });
  expectVerdict('provider_reconciliation_required: openai — x', { class: 'C', strategy: 'provider_check', paidRisk: 'uncertain' });
  expectVerdict('audiobook_script_failed: HTTP 529', { class: 'A', provider: 'anthropic' });
});

check('tabla: empaque (scope package) y restauración (R9/R10)', () => {
  const p = (m) => FC.classifyFailure({ source: 'package_worker', error: m });
  const want = (m, cls, strategy) => {
    const r = p(m);
    assert(r.class === cls && r.strategy === strategy && r.scope === 'package' && !r.unclassified, `${m}: ${JSON.stringify(r)}`);
  };
  want('Error: PACKAGING_V3_CONTENT_MISSING: no se pudo descargar x', 'A', 'repackage');
  want('fetch failed (descarga del artifact)', 'A', 'repackage');
  want('H5P_PACKAGE_INVALID: activity:c3 sin h5p.json', 'B', 'repair_package');
  want('QUIZ_V3_BANK_INVALID: x', 'B', 'repair_package');
  want('SHELL_RENDER: LOW_CONTRAST en la portada', 'D', 'hold_for_human');
  want('MBZ_V3_TOKEN_INVALID: $@X@$', 'D', 'hold_for_human');
  want('pending_video_omitted: 2 videos', 'D', 'hold_for_human');
  const u = p('algo inesperado del builder');
  assert(u.unclassified && u.class === 'A' && u.scope === 'package', 'desconocido de empaque: ' + JSON.stringify(u));
  const r = (m) => FC.classifyFailure({ source: 'restore_worker', error: m });
  assert(r('RESTORE_INFRA_DOCKER_DOWN: x').strategy === 'reverify', 'restore infra');
  assert(r('RESTORE_PRECHECK_ERROR: quiz x').class === 'B', 'restore precheck');
  assert(r('RESTORE_COUNTS_MISMATCH: 3 vs 4').class === 'D', 'restore counts');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Reglas generales
// ════════════════════════════════════════════════════════════════════════════
check('reglas: desconocido → A ×1 (unclassified, nunca silencio ni ilimitado); vacío → unknown_error; nunca lanza', () => {
  const u = v('kaboom_xyz: algo nunca visto');
  assert(u.class === 'A' && u.unclassified === true && u.targetRounds === 1 && u.code === 'kaboom_xyz' && u.strategy === 'retry_backoff', JSON.stringify(u));
  const e = v('');
  assert(e.code === 'unknown_error' && !e.unclassified, JSON.stringify(e));
  for (const bad of [null, undefined, 42, {}, 'x'.repeat(10000), '❌', '    ']) {
    const r = FC.classifyFailure({ error: bad });
    assert(FC.FAILURE_CLASSES.includes(r.class) && r.code.length <= 64, `entrada ${String(bad).slice(0, 20)}: ${JSON.stringify(r)}`);
  }
  assert(FC.UNCLASSIFIED_TERMINAL_CODE === 'unclassified_error', 'código terminal');
});

check('reglas: errorCode explícito y conocido gana sobre el mensaje; inválido/desconocido se ignora', () => {
  const r = v('cualquier texto en español', { errorCode: 'EXAM_BANK_INCOMPLETE' });
  assert(r.class === 'B' && r.code === 'EXAM_BANK_INCOMPLETE', JSON.stringify(r));
  const r2 = v('lease_expired', { errorCode: 'no es un código válido!' });
  assert(r2.code === 'lease_expired', JSON.stringify(r2));
  const r3 = v('lease_expired', { errorCode: 'codigo_que_no_existe' });
  assert(r3.code === 'lease_expired' && !r3.unclassified, 'un errorCode desconocido no tapa un mensaje conocido: ' + JSON.stringify(r3));
  const r4 = v('texto libre', { errorCode: 'codigo_que_no_existe' });
  assert(r4.unclassified && r4.code === 'codigo_que_no_existe', JSON.stringify(r4));
  assert(FC.isValidFailureCode('abc_DEF_1') && !FC.isValidFailureCode('1abc') && !FC.isValidFailureCode('a'.repeat(65)) && !FC.isValidFailureCode('a b'), 'isValidFailureCode');
});

check('reglas: invariantes de la tabla (clases/estrategias/razones válidas; C/D con acción humana; guard reasons fuera)', () => {
  const codes = FC.classifiedCodes();
  assert(codes.length > 150, 'tabla demasiado chica: ' + codes.length);
  for (const c of codes) {
    for (const src of [undefined, 'package_worker', 'restore_worker']) {
      const r = FC.classifyFailure({ error: `${c}: x`, errorCode: c, source: src });
      if (r.unclassified) continue; // el código es de otra tabla (item vs paquete)
      assert(FC.FAILURE_CLASSES.includes(r.class), `${c}: clase ${r.class}`);
      assert(FC.STRATEGIES.includes(r.strategy), `${c}: estrategia ${r.strategy}`);
      assert(!r.humanReason || FC.HUMAN_REASONS.includes(r.humanReason), `${c}: razón ${r.humanReason}`);
      if (r.class === 'D' && r.strategy === 'hold_for_human') assert(r.humanReason, `${c}: D sin humanReason`);
      if (r.class === 'C') assert(r.adminAction || r.strategy === 'provider_check', `${c}: C sin acción`);
      if (r.class === 'A' || r.class === 'B') assert(r.targetRounds >= 1, `${c}: ${r.class} sin rondas`);
    }
  }
  for (const g of FC.GUARD_REASON_CODES) assert(!codes.includes(g), `guard reason ${g} no es un fallo`);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Paso que preserva el comportamiento (auto-heal / reintento seguro)
// ════════════════════════════════════════════════════════════════════════════
check('preservación: las reglas del auto-healer y del reintento seguro son las mismas (re-exportadas), con los códigos de siempre', () => {
  assert(AH.AUTO_HEAL_ALLOW_LIST === RULES.AUTO_HEAL_ALLOW_LIST, 'allow-list re-exportada');
  assert(AH.AUTO_HEAL_DENY_PATTERNS === RULES.AUTO_HEAL_DENY_PATTERNS, 'deny re-exportada');
  assert(AH.SAFE_AUTO_RETRY_RULES === RULES.SAFE_AUTO_RETRY_RULES, 'safe re-exportada');
  assert(AH.AUTO_HEAL_SQL_ALLOW_REGEX === RULES.AUTO_HEAL_SQL_ALLOW_REGEX && AH.AUTO_HEAL_SQL_DENY_REGEX === RULES.AUTO_HEAL_SQL_DENY_REGEX, 'SQL');
  assert(JSON.stringify(AH.AUTO_HEAL_ALLOW_LIST.map((r) => r.code)) === JSON.stringify(['lease_expired', 'worker_draining', 'unexpected_error', 'download_failed',
    'gamma_timeout', 'gamma_poll_failed', 'gamma_export_missing', 'video_timeout', 'video_duration_unmeasured', 'youtube_upload_failed',
    'browser_llm_transient', 'artifact_upload_failed']), 'allow-list');
  assert(JSON.stringify(AH.SAFE_AUTO_RETRY_RULES.map((r) => r.code)) === JSON.stringify(['videogen_submit_rejected', 'gamma_submit_failed']), 'safe');
  assert(AH.SAFE_AUTO_RETRY_MAX_ROUNDS === 1 && AH.SAFE_AUTO_RETRY_BACKOFF_SECONDS === 120, 'safe constants');
});

check('preservación: todo lo que el auto-healer reabre es clase A en el clasificador; lo que la deny-list frena nunca es A/B salvo esperas de proveedor', () => {
  const NOW = new Date('2026-09-30T12:00:00Z');
  const ago = new Date(NOW.getTime() - 3600_000).toISOString();
  const allow = [['lease_expired', {}], ['worker_draining: x', {}], ['unexpected_error: x', {}], ['content_download_failed: HTTP 503', {}],
    ['gamma_timeout: x', GAMMA], ['gamma_poll_failed: x', GAMMA], ['gamma_export_missing: x', GAMMA], ['gamma_pdf_download_failed: x', GAMMA],
    ['video_timeout', VG], ['video_duration_unmeasured: x', VG], ['youtube_upload_failed: x (HTTP 503)', VG],
    ['❌ Falló después de 3 intentos: x', {}], ['no se pudo subir el artifact x: HTTP 500', {}]];
  for (const [err, os] of allow) {
    const d = AH.autoHealDecision({ status: 'failed', error: err, output_summary: os, finished_at: ago, type: 'content' }, NOW);
    assert(d.heal === true, `el healer debería reabrir ${err}: ${JSON.stringify(d)}`);
    const r = v(err, { outputSummary: os });
    assert(r.class === 'A' && !r.unclassified, `${err} → ${r.class}`);
    assert(FC.currentRecoveryOf(err, 'content', os) === 'auto_heal', `currentRecovery ${err}`);
  }
  const deny = ['ambiguous_video_submission', 'provider_reconciliation_required: x', 'budget_exceeded: x', 'youtube_blocked_quota: cuota',
    'real_video_not_allowed: x', 'provider_not_ready: x', 'youtube_blocked_auth: x', 'youtube_preflight_failed: x', 'PROVIDER_MODE_UNSET: x',
    'provider_mock_not_allowed: x', 'gamma_submit_ambiguous: x'];
  for (const err of deny) {
    assert(AH.isAutoHealDenied(err), `deny ${err}`);
    const r = v(err);
    assert((r.class === 'C' || r.class === 'D') || (r.class === 'A' && r.strategy === 'wait_provider'), `${err} denegado pero clasificado ${r.class}/${r.strategy}`);
    assert(FC.currentRecoveryOf(err, 'video', {}) === 'denied', `currentRecovery deny ${err}`);
  }
  // Reintento seguro: mismo criterio que safeAutoRetryDecision.
  const safeVg = 'videogen_submit_rejected: Videogen rechazó el envío (HTTP 422)';
  assert(AH.safeAutoRetryDecision({ status: 'failed', error: safeVg, type: 'video', output_summary: {}, finished_at: ago }, NOW).heal === true, 'safe vg');
  assert(FC.currentRecoveryOf(safeVg, 'video', {}) === 'safe_auto_retry', 'currentRecovery safe vg');
  assert(FC.currentRecoveryOf('videogen_submit_rejected: (HTTP 409)', 'video', {}) === 'manual', '409 no es definitivo');
  assert(FC.currentRecoveryOf('gamma_submit_failed: 400', 'presentation', {}) === 'safe_auto_retry', 'safe gamma');
  assert(FC.currentRecoveryOf('v3_payload_invalid: x', 'activity', {}) === 'manual', 'B hoy es manual');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. GATE: todo código emitido hoy tiene regla explícita
// ════════════════════════════════════════════════════════════════════════════
const be = SCAN.scanBackendEmitters(REPO);

check(`gate backend: ${be.emitters.length} emisores de fallo resueltos (ninguno sin resolver; helpers verificados)`, () => {
  assert(be.emitters.length >= 60, `muy pocos emisores encontrados (${be.emitters.length}): ¿cambió el escáner?`);
  const un = be.emitters.filter((e) => !e.codes);
  assert(un.length === 0, 'emisores sin resolver (agrega la regla o una entrada en DYNAMIC_EMITTERS de scripts/lib/rel-error-emitters.js):\n' +
    un.map((e) => `${e.file}:${e.line}  ${e.expr.slice(0, 160)}`).join('\n'));
  const bad = be.fnMentions.filter((f) => !f.ok);
  assert(bad.length === 0, 'FN_CODES desactualizado (el helper ya no arma su código): ' + bad.map((f) => f.fn).join(', '));
  // Las entradas DYNAMIC_EMITTERS siguen existiendo (si no, el mapa quedó viejo).
  const keys = new Set(be.emitters.map((e) => e.key));
  const stale = Object.keys(SCAN.DYNAMIC_EMITTERS).filter((k) => !keys.has(k));
  assert(stale.length === 0, 'DYNAMIC_EMITTERS con expresiones que ya no existen: ' + stale.join(' | '));
});

check('gate backend: cada código emitido tiene una regla EXPLÍCITA', () => {
  const missing = [];
  const codes = new Set();
  for (const e of be.emitters) for (const c of e.codes || []) codes.add(c);
  for (const c of codes) {
    const src = c === 'PACKAGE_BUILDER_ERROR' ? 'package_worker' : undefined;
    const r = FC.classifyFailure({ error: `${c}: detalle`, source: src, outputSummary: {} });
    if (r.unclassified || !FC.isFailureCodeClassified(c)) missing.push(c);
  }
  assert(missing.length === 0, 'códigos emitidos sin regla en failure-classifier.ts: ' + missing.sort().join(', '));
  console.log(`   (${codes.size} códigos de fallo distintos)`);
});

check('gate backend: cada código interno de validación (v3_payload_invalid [..], banco, H5P, GIFT) está clasificado', () => {
  const val = SCAN.scanValidationCodes(REPO);
  const missingFiles = [...val.keys()].filter((k) => k.startsWith('__missing_file__'));
  assert(missingFiles.length === 0, 'archivos de validadores que ya no existen: ' + missingFiles.join(', '));
  const missing = [...val.keys()].filter((c) => !FC.isKnownValidationCode(c));
  assert(missing.length === 0, 'códigos de validación sin clasificar: ' + missing.map((c) => `${c} (${val.get(c)})`).join(', '));
  console.log(`   (${val.size} códigos de validación)`);
});

check('gate backend: cada código de error del empaque/validación del .mbz está clasificado (scope package)', () => {
  const pk = SCAN.scanPackageCodes(REPO);
  const missing = [];
  for (const c of pk.keys()) {
    const r = FC.classifyFailure({ source: 'package_worker', error: `${c}: detalle` });
    if (r.unclassified) missing.push(`${c} (${pk.get(c)})`);
  }
  assert(missing.length === 0, 'códigos de empaque sin clasificar: ' + missing.join(', '));
  console.log(`   (${pk.size} códigos de empaque)`);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Ejecutor del navegador (opcional)
// ════════════════════════════════════════════════════════════════════════════
// Expresiones (no literales) del ejecutor → mensajes de ejemplo que producen.
const FE_EXPR_SAMPLES = [
  [/inválido tras reintento dirigido/, ['activity inválido tras reintento dirigido: falta x', 'OUTPUT_TRUNCATED_MAX_TOKENS: activity inválido tras reintento dirigido: x']],
  [/'text_fetch_failed'/, ['text_fetch_failed']],
  [/'download_url_failed'/, ['download_url_failed']],
  [/'ambiguous_'.*'missing_'.*_artifact/, ['ambiguous_dynamic_content_md_artifact: el item x', 'missing_dynamic_content_md_artifact: el item x']],
  [/'_download_failed: '/, ['dynamic_content_md_download_failed: desconocido']],
  [/'_empty: el artifact '/, ['dynamic_context_package_json_empty: el artifact a está vacío']],
  [/^\(e && e\.message\) \|\| String\(e\)/, []], // excepción cruda: la clasifica el mensaje de api() (04-api.js, escaneado abajo)
];

if (FE_DIR) {
  const exec = path.join(FE_DIR, 'src/js/45-dynamic-generation-executor.js');
  const api = path.join(FE_DIR, 'src/js/04-api.js');
  check(`gate frontend (${path.relative(process.cwd(), FE_DIR) || FE_DIR}): cada mensaje de fallo del ejecutor y de api() se clasifica explícitamente`, () => {
    assert(fs.existsSync(exec) && fs.existsSync(api), 'no existe el ejecutor/api en ' + FE_DIR);
    const entries = SCAN.scanFrontendExecutor(exec);
    assert(entries.length >= 40, 'muy pocos mensajes del ejecutor: ' + entries.length);
    const missing = [];
    const samples = [];
    for (const e of entries) {
      if (e.text.startsWith('__errorCode__ ')) { const c = e.text.slice(14); if (!FC.isFailureCodeClassified(c)) missing.push(`L${e.line} errorCode ${c}`); continue; }
      if (e.text.startsWith('__expr__ ')) {
        const expr = e.text.slice(9);
        const hit = FE_EXPR_SAMPLES.find(([re]) => re.test(expr));
        if (!hit) { missing.push(`L${e.line} expresión sin muestra: ${expr.slice(0, 120)}`); continue; }
        for (const s of hit[1]) samples.push([e.line, s]);
        continue;
      }
      samples.push([e.line, e.text]);
    }
    for (const e of SCAN.scanFrontendApi(api)) {
      let t = e.text;
      if (/Fall[oó] despu[eé]s de $/.test(t)) t += '3 intentos: x';
      else if (/\($/.test(t)) t += '503). Reintentando…';
      samples.push([`api:${e.line}`, t]);
    }
    for (const [line, s] of samples) {
      const r = FC.classifyFailure({ error: s.endsWith(' ') ? s + 'x' : s });
      if (r.unclassified) missing.push(`L${line} «${s.slice(0, 100)}» → ${r.code}`);
    }
    assert(missing.length === 0, 'mensajes del navegador sin regla:\n' + missing.join('\n'));
    console.log(`   (${samples.length} mensajes del navegador)`);
  });
} else {
  console.log('ℹ️  gate frontend omitido (sin --fe <dir del frontend>; el frontend es otro repo)');
}

console.log(`\n${failures === 0 ? '✅' : '❌'} check-rel-failure-classes: ${passes} ok, ${failures} fallidos`);
process.exit(failures === 0 ? 0 : 1);
