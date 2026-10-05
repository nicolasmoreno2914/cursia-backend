#!/usr/bin/env node
/* eslint-disable */
// REL R1 — clasificador central de fallos (src/modules/reliability/failure-classifier.ts).
//
// Puro (sin DB, sin red):
//   1. tabla del diseño §3.2: mensajes reales → clase / código / estrategia / scope / riesgo de pago;
//   2. reglas (fix round 1): el errorCode del ejecutor NO es de confianza — solo SUBE la severidad, nunca
//      baja ni pisa un hecho del servidor (C1); desconocido → D retenido (`unclassified`, I4); el status
//      HTTP solo clasifica llamadas HTTP de la IA (I4); cuota/crédito/auth de proveedor → D-config scope
//      provider (I1); nunca lanza;
//   3. paso que preserva el comportamiento: las reglas del auto-healer y del reintento seguro son
//      las MISMAS (re-exportadas), y `currentRecoveryOf` coincide con autoHealDecision/safeAutoRetryDecision;
//   (Fix round 2, N1) Los gates son BEST-EFFORT: la garantía está en runtime (D retenido + unclassified=true
//   en el log + verify-rel-no-unclassified en la compuerta E2E). Límites conocidos: header de
//   scripts/lib/rel-error-emitters.js.
//   4. GATE: cada código que el backend EMITE hoy (failItem / fail(deps / applyItemFailure /
//      failJob / blockItemForBudget, resueltos desde el código fuente) tiene una regla EXPLÍCITA;
//      cada código interno de validación y de empaque también. Un emisor nuevo sin resolver o un
//      código nuevo sin regla → el check falla;
//   5. (con --fe <dir del frontend>) lo mismo para el ejecutor del navegador
//      (45-dynamic-generation-executor.js + 04-api.js); en CI (deploy-staging, regresión E2E) corre con
//      --require-fe (sin --fe falla). Auto-tests del escáner sobre scripts/fixtures/rel-gate (backend y
//      frontend): las construcciones que la review mostró invisibles tienen que detectarse.
//
// Uso: npm run build && node scripts/check-rel-failure-classes.js [--require-fe] [--fe ../campuscloud-gen] [path/to/dist]

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
function eq2(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); }

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
  // I4: el status HTTP solo decide en llamadas HTTP de la IA (por fuente); un worker con un mensaje desconocido sigue desconocido (D).
  expectVerdict('upstream said no (HTTP 503)', { class: 'A', code: 'llm_transient', httpStatus: 503 }, { source: 'browser_executor' });
  expectVerdict('algo raro', { class: 'A', code: 'llm_transient' }, { httpStatus: 524, source: 'llm_gateway' });
  for (const src of ['video_worker', 'provider_worker', 'scheduler', undefined]) {
    const w = v('kaboom (HTTP 503)', { source: src });
    assert(w.unclassified && w.class === 'D' && w.provider === null && w.strategy === 'hold_for_human', `${src}: ${JSON.stringify(w)}`);
  }
  assert(v('kaboom (HTTP 503)', { source: 'video_worker' }).paidRisk === 'uncertain', 'desconocido de un worker pagado: riesgo incierto');
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
  // I5: sin generationId persistido no hay de dónde re-bajar → B; CON la generación (ya pagada) → A re-descarga gratis.
  for (const m of ['presentation_artifact_invalid: SLIDE_COUNT, PDF_MISSING', 'gamma_pdf_invalid: x', 'PDF_MISSING: x', 'COVER_BYTES: x', 'PNG_SIGNATURE: x']) {
    expectVerdict(m, { class: 'B', strategy: 'regenerate_targeted', provider: 'gamma' });
    expectVerdict(m, { class: 'A', strategy: 'repoll_external', paidRisk: 'none', targetRounds: 1 }, { outputSummary: GAMMA });
  }
  expectVerdict('PRESENTATION_CARD_SLIDE_COUNT: 9 ≠ 10', { class: 'B', strategy: 'regenerate_targeted' }, { outputSummary: GAMMA });
  expectVerdict('gamma_generation_failed: la generación g falló en Gamma (x) [Gamma no informó los créditos: cobro incierto]. No se reenvía sola',
    { class: 'C', strategy: 'hold_for_human', paidRisk: 'uncertain', adminAction: 'reconcile_provider' });
  expectVerdict('gamma_generation_failed: x', { class: 'C', paidRisk: 'uncertain' });
  expectVerdict('gamma_generation_failed: la generación g falló en Gamma (x) [créditos medidos: 40]. No se reenvía sola',
    { class: 'B', strategy: 'regenerate_targeted', paidRisk: 'measured' });
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
    'video_duration_unmeasurable: el MP4 del video x', 'provider_worker_wrong_type: content', 'missing_artifact_id', 'artifact_download_unavailable',
    'practice_sources_missing: el claim del capítulo de práctica experience:x no trae sourceChapterIds']) {
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
  expectVerdict('tts_failed: chunk 1/4: openai POST /audio/speech HTTP 429: rate limit, retry later', { class: 'A', strategy: 'retry_backoff' });
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
  assert(u.unclassified && u.class === 'D' && u.scope === 'package' && u.strategy === 'hold_for_human', 'desconocido de empaque: ' + JSON.stringify(u));
  const r = (m) => FC.classifyFailure({ source: 'restore_worker', error: m });
  assert(r('RESTORE_INFRA_DOCKER_DOWN: x').strategy === 'reverify', 'restore infra');
  assert(r('RESTORE_PRECHECK_ERROR: quiz x').class === 'B', 'restore precheck');
  assert(r('RESTORE_COUNTS_MISMATCH: 3 vs 4').class === 'D', 'restore counts');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Reglas generales
// ════════════════════════════════════════════════════════════════════════════
check('reglas (I4): desconocido → D retenido (unclassified, humano + alerta; nunca A ni reintento); vacío → unknown_error; nunca lanza', () => {
  const u = v('kaboom_xyz: algo nunca visto');
  assert(u.class === 'D' && u.unclassified === true && u.targetRounds === 0 && u.code === 'kaboom_xyz' && u.strategy === 'hold_for_human'
    && u.humanReason === 'unrecoverable', JSON.stringify(u));
  const e = v('');
  assert(e.code === 'unknown_error' && !e.unclassified, JSON.stringify(e));
  for (const bad of [null, undefined, 42, {}, 'x'.repeat(10000), '❌', '    ']) {
    const r = FC.classifyFailure({ error: bad });
    assert(FC.FAILURE_CLASSES.includes(r.class) && r.code.length <= 64, `entrada ${String(bad).slice(0, 20)}: ${JSON.stringify(r)}`);
  }
  assert(FC.UNCLASSIFIED_TERMINAL_CODE === 'unclassified_error', 'código terminal');
});

check('reglas (C1): un errorCode del ejecutor solo SUBE la severidad — nunca baja C/D ni pisa un hecho del servidor', () => {
  // Cada downgrade de la review (y variantes): el veredicto queda el del MENSAJE, con el código reportado registrado.
  const downgrades = [
    ['provider_reconciliation_required: openai — audio pagado sin persistir', 'llm_transient', 'C'],
    ['ambiguous_video_submission: timeout', 'lease_expired', 'C'],
    ['budget_exceeded: no_authorization', 'content_empty', 'D'],
    ['budget_exceeded: x', 'unexpected_error', 'D'],
    ['videogen_failed: render', 'worker_draining', 'C'],
    ['gamma_submit_ambiguous: sin confirmar', 'validation_invalid', 'C'],
    ['real_video_not_allowed: x', 'llm_transient', 'D'],
    ['claim_payload_unavailable: x', 'EXAM_BANK_INCOMPLETE', 'D'],
    ['tts_failed: chunk 3/4: HTTP 503', 'llm_transient', 'C'],
    ['❌ Sin disponibilidad de generación. Contacta a soporte de Cursia.', 'llm_transient', 'D'],
    ['v3_payload_invalid: activity x [BS_UNREACHABLE]', 'unknown_error', 'B'],
    ['kaboom_desconocido: x', 'llm_transient', 'D'],
  ];
  for (const [msg, code, want] of downgrades) {
    for (const source of ['browser_executor', 'video_worker', 'provider_worker', undefined]) {
      const r = v(msg, { errorCode: code, source });
      assert(r.class === want, `downgrade «${msg}» + errorCode ${code} (${source}) → ${r.class} (esperado ${want})`);
      assert(r.reportedCode === code && r.reportedCodeIgnored === true, `código reportado registrado e ignorado: ${JSON.stringify(r)}`);
    }
  }
  // Riesgo de pago: nunca baja.
  const pr = v('lease_expired', { errorCode: 'EXAM_BANK_INCOMPLETE', itemType: 'video', source: 'video_worker' });
  assert(pr.class === 'B' && pr.paidRisk === 'uncertain', 'B por el código pero con el riesgo incierto del lease de un worker: ' + JSON.stringify(pr));
  // Subir sí: un mensaje A con un código de validación B (navegador) → B; un mensaje B con un código D de contrato → D.
  const up = v('Servidor ocupado (529). Reintentando…', { errorCode: 'EXAM_BANK_INCOMPLETE', source: 'browser_executor' });
  assert(up.class === 'B' && up.code === 'EXAM_BANK_INCOMPLETE' && up.reportedCodeIgnored === false, JSON.stringify(up));
  const up2 = v('activity inválido tras reintento dirigido: x', { errorCode: 'claim_contract', source: 'browser_executor' });
  assert(up2.class === 'D', JSON.stringify(up2));
  // Del navegador solo códigos que el navegador produce: un código de servidor/worker se ignora aunque "suba".
  for (const code of ['budget_exceeded', 'ambiguous_video_submission', 'provider_reconciliation_required', 'videogen_failed', 'lease_expired', 'worker_draining', 'youtube_blocked_auth']) {
    const r = v('contenido vacío tras generación', { errorCode: code, source: 'browser_executor' });
    assert(r.class === 'B' && r.code === 'content_empty' && r.reportedCodeIgnored === true, `${code} desde el navegador: ${JSON.stringify(r)}`);
  }
  // Mismo nivel: gana el mensaje (hecho); un mensaje desconocido (D) con un código conocido D → el código (más informativo).
  const same = v('Servidor ocupado (529). Reintentando…', { errorCode: 'artifact_upload_failed', source: 'browser_executor' });
  assert(same.code === 'llm_transient' && same.reportedCodeIgnored === true, JSON.stringify(same));
  const unk = v('texto libre nunca visto', { errorCode: 'claim_contract', source: 'browser_executor' });
  assert(unk.class === 'D' && unk.code === 'claim_contract' && !unk.unclassified, JSON.stringify(unk));
  const unk2 = v('texto libre nunca visto', { errorCode: 'EXAM_BANK_INCOMPLETE', source: 'browser_executor' });
  assert(unk2.class === 'D' && unk2.unclassified, 'un código B no baja un desconocido (D): ' + JSON.stringify(unk2));
  // Inválido / desconocido: se ignora.
  const r2 = v('lease_expired', { errorCode: 'no es un código válido!' });
  assert(r2.code === 'lease_expired' && !r2.reportedCode, JSON.stringify(r2));
  const r3 = v('lease_expired', { errorCode: 'codigo_que_no_existe' });
  assert(r3.code === 'lease_expired' && r3.reportedCode === 'codigo_que_no_existe' && r3.reportedCodeIgnored, JSON.stringify(r3));
  assert(FC.isValidFailureCode('abc_DEF_1') && !FC.isValidFailureCode('1abc') && !FC.isValidFailureCode('a'.repeat(65)) && !FC.isValidFailureCode('a b'), 'isValidFailureCode');
});

// I1: cuerpos REALES de provider-clients.ts / real-providers.ts.
const PROVIDER_BODY_SAMPLES = [
  ['tts_failed: chunk 1/4: openai POST /audio/speech HTTP 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}', 'openai'],
  ['tts_failed: chunk 1/4: openai POST /audio/speech HTTP 401: Incorrect API key provided', 'openai'],
  ['audiobook_script_failed: anthropic POST /v1/messages HTTP 400: {"error":{"message":"Your credit balance is too low"}}', 'anthropic'],
  ['audiobook_script_failed: anthropic POST /v1/messages HTTP 401: invalid x-api-key', 'anthropic'],
  ['gamma_submit_failed: gamma POST /generations HTTP 401: Unauthorized', 'gamma'],
  ['gamma_submit_failed: gamma POST /generations HTTP 402: Payment Required — not enough credits', 'gamma'],
  ['gamma_poll_failed: gamma GET /generations/g HTTP 403: Forbidden', 'gamma'],
  ['videogen_submit_rejected: Videogen rechazó el envío (HTTP 402): insufficient credits', 'videogen'],
  ['videogen_submit_rejected: Videogen rechazó el envío (HTTP 403)', 'videogen'],
  ['unexpected_error: openai POST /audio/speech HTTP 429: insufficient_quota', 'openai'],
];

check('tabla (I1): cuota / crédito / auth / facturación de un proveedor → D-config scope PROVIDER (wait_provider, sin quemar intentos); 429 sin cuota → A', () => {
  for (const [msg, provider] of PROVIDER_BODY_SAMPLES) {
    for (const os of [{}, GAMMA, VG]) {
      expectVerdict(msg, { class: 'D', strategy: 'wait_provider', scope: 'provider', humanReason: 'config', provider, targetRounds: 0 }, { outputSummary: os });
    }
  }
  expectVerdict('tts_failed: chunk 1/4: openai POST /audio/speech HTTP 429: Rate limit reached, try again in 2s', { class: 'A', strategy: 'retry_backoff' });
  expectVerdict('audiobook_script_failed: anthropic POST /v1/messages HTTP 529: overloaded', { class: 'A' });
  expectVerdict('gamma_poll_failed: gamma GET /generations/g HTTP 503', { class: 'A', strategy: 'repoll_external' }, { outputSummary: GAMMA });
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

check('preservación (propiedad, M8a): para CADA código emitido × cuerpos reales de proveedor, deny-list ⇒ C/D o espera de proveedor', () => {
  const bodies = ['', ': HTTP 503', ': HTTP 429: {"error":{"code":"insufficient_quota"}}', ': HTTP 401: Unauthorized', ': HTTP 402: Payment Required',
    ': HTTP 400: Your credit balance is too low', ': HTTP 403: Forbidden', ': timeout', ': chunk 3/4: HTTP 429: insufficient_quota'];
  const codes = new Set();
  for (const e of SCAN.scanBackendEmitters(REPO).emitters) for (const c of e.codes || []) codes.add(c);
  let n = 0;
  for (const c of codes) {
    // Cuerpos de proveedor SOLO en los códigos cuyos mensajes los traen de verdad (llamadas a un proveedor).
    const isCall = FC.PROVIDER_CALL_RULE_IDS.includes(FC.classifyFailure({ error: `${c}: x`, source: 'provider_worker' }).rule);
    for (const b of isCall ? bodies : ['', ': timeout', ': HTTP 503']) {
      for (const os of [{}, GAMMA, VG]) {
        const msg = `${c}${b}`;
        const src = c === 'PACKAGE_BUILDER_ERROR' ? 'package_worker' : 'provider_worker';
        const r = FC.classifyFailure({ error: msg, outputSummary: os, source: src });
        n++;
        if (AH.isAutoHealDenied(msg)) assert(r.class === 'C' || r.class === 'D' || r.strategy === 'wait_provider', `denegado pero ${r.class}/${r.strategy}: ${msg}`);
        // Cuota/crédito/auth en una llamada a proveedor: D-config scope provider CON proveedor; sin proveedor
        // conocido, D retenido scope item (N3); con trozos de TTS ya pagados, C (N5). Nunca un reintento.
        if (isCall && /quota|credit|HTTP 40[123]/.test(b)) {
          const ok = (r.class === 'D' && r.scope === 'provider' && r.strategy === 'wait_provider' && r.provider)
            || (r.class === 'D' && r.scope === 'item' && r.strategy === 'hold_for_human' && !r.provider)
            || (r.class === 'C' && r.adminAction === 'reconcile_provider' && r.paidUnits > 0);
          assert(ok, `cuota/crédito/auth mal clasificada: ${msg} → ${r.class}/${r.scope}/${r.strategy}/${r.provider}`);
        }
        assert(!r.unclassified || src === 'package_worker', `emitido y sin clasificar: ${msg}`);
      }
    }
  }
  console.log(`   (${n} combinaciones código × cuerpo × output_summary)`);
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
  assert(FC.currentRecoveryOf('v3_payload_invalid: x', 'activity', {}) === 'auto_regenerate', 'REL MVP: B de la IA se regenera sola');
  assert(FC.currentRecoveryOf('v3_payload_invalid: x', 'activity', { autoHeal: { regenRounds: 2 } }) === 'manual', 'REL MVP: B con el tope usado → humano');
});

check('fix round 2 (N2): piso de dinero en runtime — un texto de la deny-list es ≥ C aunque el código de adelante sea A/B', () => {
  const cases = [
    ['unexpected_error: budget_exceeded: el envío superaría el presupuesto', 'budget', 'approve_budget'],
    ['unexpected_error: provider_reconciliation_required: openai — audio pagado sin persistir', 'duplicate_charge', 'reconcile_provider'],
    ['unexpected_error: ambiguous submission (timeout del envío)', 'duplicate_charge', 'reconcile_provider'],
    ['unexpected_error: el envío quedó ambiguo', 'duplicate_charge', 'reconcile_provider'],
    ['unexpected_error: saldo insuficiente', 'duplicate_charge', 'reconcile_provider'],
    ['unexpected_error: provider_mode_unset para gamma', 'config', 'retry_item'],
  ];
  for (const [msg, reason, action] of cases) {
    for (const source of ['video_worker', 'provider_worker', 'browser_executor', undefined]) {
      const r = v(msg, { source });
      assert(['C', 'D'].includes(r.class) && r.strategy !== 'retry_backoff', `${msg} (${source}) → ${r.class}/${r.strategy}`);
      if (r.class === 'C' && r.moneyFloor) eq2([r.humanReason, r.adminAction], [reason, action], msg);
    }
  }
  const g = v('gamma_poll_failed: ambiguous response del poll', { outputSummary: GAMMA });
  assert(g.class === 'C' && g.moneyFloor === true && g.paidRisk === 'uncertain', 'gamma_poll_failed ambiguo con id: ' + JSON.stringify(g));
  // Excepciones: esperas de proveedor (cuota de YouTube) y códigos de validación con la palabra.
  expectVerdict('youtube_blocked_quota: cuota diaria agotada', { class: 'A', strategy: 'wait_provider' });
  const ex = v('v3_payload_invalid: exam exam:m1 rechazado por el validador del servidor [EXAM_ARTIFACT_AMBIGUOUS] $ EXAM_ARTIFACT_AMBIGUOUS: se subieron 2');
  assert(ex.class === 'B' && !ex.moneyFloor, 'EXAM_ARTIFACT_AMBIGUOUS no es un pago: ' + JSON.stringify(ex));
  // Un errorCode no puede esquivar el piso.
  assert(v('unexpected_error: budget_exceeded: x', { errorCode: 'EXAM_BANK_INCOMPLETE', source: 'video_worker' }).class === 'C', 'piso con errorCode');
});

check('fix round 2 (N3): nunca scope provider sin proveedor — por tipo de item, si no D retenido scope item', () => {
  expectVerdict('unexpected_error: descarga del artifact falló (HTTP 403)', { class: 'D', scope: 'item', strategy: 'hold_for_human', provider: null });
  expectVerdict('unexpected_error: HTTP 403', { class: 'D', scope: 'provider', provider: 'videogen', strategy: 'wait_provider' }, { itemType: 'video' });
  expectVerdict('unexpected_error: HTTP 401', { class: 'D', scope: 'provider', provider: 'gamma' }, { itemType: 'presentation' });
  expectVerdict('unexpected_error: Videogen POST /jobs (HTTP 401)', { class: 'D', scope: 'provider', provider: 'videogen' });
  for (const c of FC.classifiedCodes()) {
    for (const b of ['', ': HTTP 401', ': insufficient_quota', ': forbidden']) {
      for (const itemType of [null, 'content', 'video', 'presentation', 'audiobook_chapter']) {
        const r = FC.classifyFailure({ error: `${c}${b}`, itemType });
        assert(r.scope !== 'provider' || r.provider, `scope provider sin proveedor: ${c}${b} (${itemType})`);
      }
    }
  }
});

check('fix round 2 (N4): el marcador de créditos medidos está anclado al sufijo del worker', () => {
  const uncertainEcho = 'gamma_generation_failed: la generación g falló en Gamma (curso de contabilidad: créditos medidos al cierre) [Gamma no informó los créditos: cobro incierto]. No se reenvía sola: regenera la presentación';
  expectVerdict(uncertainEcho, { class: 'C', paidRisk: 'uncertain' });
  expectVerdict('gamma_generation_failed: x (texto [créditos medidos: 12] de Gamma) [Gamma no informó los créditos: cobro incierto]. No se reenvía sola', { class: 'C' });
  expectVerdict('gamma_generation_failed: la generación g falló en Gamma (x) [créditos medidos: 12.5]. No se reenvía sola: regenera', { class: 'B', paidRisk: 'measured' });
});

check('fix round 2 (N5): TTS después del trozo 1 (trozos ya pagados) — nunca retry_item; cuota en un trozo > 1 → C con el contexto de config y los trozos pagados', () => {
  const r = expectVerdict('tts_failed: chunk 3/4: openai POST /audio/speech HTTP 429: {"error":{"code":"insufficient_quota"}}',
    { class: 'C', strategy: 'hold_for_human', adminAction: 'reconcile_provider', humanReason: 'duplicate_charge', paidRisk: 'uncertain', provider: 'openai', scope: 'item' });
  assert(r.providerConfigIssue === true && r.paidUnits === 2, 'contexto: ' + JSON.stringify(r));
  const r2 = expectVerdict('tts_failed: chunk 2/4: HTTP 401: Incorrect API key', { class: 'C', adminAction: 'reconcile_provider' });
  assert(r2.paidUnits === 1 && r2.providerConfigIssue, JSON.stringify(r2));
  const r3 = expectVerdict('tts_failed: chunk 3/4: HTTP 503', { class: 'C', strategy: 'auto_resubmit_once', adminAction: 'reconcile_provider', paidRisk: 'uncertain' });
  assert(r3.paidUnits === 2 && !r3.providerConfigIssue, JSON.stringify(r3));
  // Trozo 1: nada pagado → D-config a scope provider (pausa al proveedor) o A transitorio.
  expectVerdict('tts_failed: chunk 1/4: HTTP 429: insufficient_quota', { class: 'D', scope: 'provider', strategy: 'wait_provider', adminAction: 'retry_item' });
  for (let n = 2; n <= 6; n++) {
    for (const body of ['HTTP 503', 'HTTP 429: insufficient_quota', 'HTTP 401', 'saldo agotado', 'cuota agotada', 'timeout']) {
      const x = v(`tts_failed: chunk ${n}/6: ${body}`, { itemType: 'audiobook_chapter', source: 'provider_worker' });
      assert(x.adminAction !== 'retry_item' && x.class === 'C', `trozo ${n} «${body}» → ${x.class}/${x.adminAction}`);
    }
  }
});

check('fix round 2 (N7): cuota/saldo en español es configuración del proveedor (paridad con la deny-list)', () => {
  expectVerdict('tts_failed: chunk 1/4: openai HTTP 429: cuota agotada', { class: 'D', strategy: 'wait_provider', scope: 'provider' });
  expectVerdict('gamma_submit_failed: gamma POST /generations HTTP 400: saldo insuficiente', { class: 'D', strategy: 'wait_provider', provider: 'gamma' });
});

check('#583 (merge de staging): el reenvío automático ÚNICO de audio TTS incierto (≤ USD 0.10) es coherente con la clase C del clasificador', () => {
  const msg = 'provider_reconciliation_required: openai — audio TTS pagado sin persistir. El proveedor pudo haber completado';
  for (const itemType of ['audio_welcome', 'audiobook_chapter']) {
    const r = expectVerdict(msg, { class: 'C', strategy: 'auto_resubmit_once', paidRisk: 'uncertain', adminAction: 'reconcile_provider', provider: 'openai' }, { itemType });
    assert(FC.currentRecoveryOf(msg, itemType, {}) === 'ambiguous_audio_resubmit', 'currentRecovery ' + itemType);
    assert(FC.currentRecoveryOf(msg, itemType, { ambiguousAudioResubmit: { rounds: 1 } }) === 'denied', 'una sola vez');
    assert(FC.currentRecoveryOf(msg, itemType, { ambiguousAudioResubmit: { declined: 'over_threshold' } }) === 'denied', 'rechazado → admin');
    void r;
  }
  // Fuera de la regla: guion LLM (anthropic), video, presentación → C provider_check, nunca reenvío automático.
  expectVerdict('provider_reconciliation_required: anthropic — guion pagado sin persistir', { class: 'C', strategy: 'provider_check' }, { itemType: 'audiobook_chapter' });
  assert(FC.currentRecoveryOf('provider_reconciliation_required: anthropic — x', 'audiobook_chapter', {}) === 'denied', 'anthropic');
  for (const itemType of ['video', 'presentation']) {
    expectVerdict(msg, { class: 'C', strategy: 'provider_check' }, { itemType });
    assert(FC.currentRecoveryOf(msg, itemType, {}) === 'denied', itemType);
  }
  // Decisión A: el tope de USD 0.10 lo decide auto-heal con el ledger (misma función que usa el clasificador).
  const NOW = new Date('2026-10-02T12:00:00Z');
  const row = { status: 'failed', type: 'audiobook_chapter', error: msg, output_summary: {}, finished_at: new Date(NOW.getTime() - 600_000).toISOString() };
  assert(AH.AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD === 0.1 && AH.AMBIGUOUS_AUDIO_RESUBMIT_MAX_ROUNDS === 1, 'constantes de la decisión A');
  assert(AH.ambiguousAudioResubmitDecision(row, NOW, { pendingUsd: 0.04, providers: ['openai'] }).heal === true, '≤ 0.10 → un reenvío');
  assert(AH.ambiguousAudioResubmitDecision(row, NOW, { pendingUsd: 0.1, providers: ['openai'] }).heal === true, '= 0.10 → un reenvío');
  const over = AH.ambiguousAudioResubmitDecision(row, NOW, { pendingUsd: 0.11, providers: ['openai'] });
  assert(over.heal === false && over.reason === 'over_threshold', '> 0.10 → admin');
  assert(AH.ambiguousAudioResubmitDecision(row, NOW, { pendingUsd: 0.04, providers: ['anthropic', 'openai'] }).heal === false, 'otro proveedor pendiente → admin');
  // TTS incierto por trozos (N5) no es este caso (tts_failed, no provider_reconciliation_required): C reconcile.
  const t = v('tts_failed: chunk 3/4: HTTP 503', { itemType: 'audiobook_chapter' });
  assert(t.class === 'C' && t.adminAction === 'reconcile_provider' && FC.currentRecoveryOf('tts_failed: chunk 3/4: HTTP 503', 'audiobook_chapter', {}) !== 'ambiguous_audio_resubmit', 'tts_failed');
});

check('cursia#68: cortes del stream SSE de la IA → A transitorio (sin riesgo de pago extra); el reintento de descarga conserva la clase del error interno', () => {
  for (const m of ['La respuesta de la IA se cortó antes de terminar. Reintentando…', 'Se cortó la conexión con la IA. Reintentando…',
    'La IA dejó de responder (90 s sin datos). Reintentando…', 'Respuesta de la IA incompleta', '❌ Falló después de 3 intentos: La respuesta de la IA se cortó antes de terminar. Reintentando…']) {
    const r = v(m, { source: 'browser_executor' });
    assert(r.class === 'A' && r.strategy === 'retry_backoff' && r.paidRisk === 'measured' && !r.unclassified, `${m} → ${JSON.stringify(r)}`);
  }
  expectVerdict('Respuesta ilegible de la API', { class: 'A' }, { source: 'browser_executor' });
  expectVerdict('Servidor ocupado (stream: overloaded_error). Reintentando…', { class: 'A', code: 'llm_transient' }, { source: 'browser_executor' });
  const inner = ['text_fetch_failed', 'download_url_failed', 'sign_failed', 'unsupported_download_method', 'artifact_download_unavailable', 'missing_artifact_id',
    'dynamic_content_md_download_failed: HTTP 503', 'EXAM_BANK_CHAPTER_MD_MISSING: no se pudo leer el texto del capítulo c (HTTP 503)'];
  for (const i of inner) {
    const a = v(i, { source: 'browser_executor' });
    const b = v(`${i} (tras 3 intentos)`, { source: 'browser_executor' });
    assert(a.class === b.class && a.code === b.code && a.strategy === b.strategy, `«${i}» envuelto cambia de clase: ${a.class}/${a.code} → ${b.class}/${b.code}`);
  }
  // El piso de dinero sigue mirando el texto completo del envoltorio.
  const f = v('dynamic_content_md_download_failed: presupuesto agotado del Storage (tras 3 intentos)', { source: 'browser_executor' });
  assert(['C', 'D'].includes(f.class), 'piso de dinero con el envoltorio: ' + JSON.stringify(f));
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
/**
 * Expresiones NO literales del ejecutor que existen HOY (revisadas una por una, texto EXACTO) → mensajes que
 * producen. Es deuda explícita: cuando el frontend mande `errorCode` en cada {ok:false} (mitad FE de R1),
 * cada entrada se reemplaza por su código. Cualquier expresión NUEVA (template, variable, helper) que no esté
 * acá hace fallar el gate (I3).
 */
const FE_EXPR_SAMPLES = new Map([
  ["item.type + ' inválido tras reintento dirigido: falta ' + problems.join('; ')", ['activity inválido tras reintento dirigido: falta x']],
  ["(truncated ? 'OUTPUT_TRUNCATED_MAX_TOKENS: ' : '') + item.type + ' inválido tras reintento dirigido: ' + (errors || []).slice(0, 8).join('; ')",
    ['activity inválido tras reintento dirigido: x', 'OUTPUT_TRUNCATED_MAX_TOKENS: activity inválido tras reintento dirigido: x']],
  ["(e && e.message) || 'text_fetch_failed'", ['text_fetch_failed', 'fetch failed']],
  ["(urlRes && urlRes.error) || 'download_url_failed'", ['download_url_failed']],
  ["(deps.length ? 'ambiguous_' : 'missing_') + type + '_artifact: el item ' + item.itemKey + ' recibió ' + deps.length + ' artifacts ' + type + ' (se esperaba 1)'",
    ['ambiguous_dynamic_content_md_artifact: el item x', 'missing_dynamic_content_md_artifact: el item x']],
  ["type + '_download_failed: ' + ((dl && dl.error) || 'desconocido')", ['dynamic_content_md_download_failed: desconocido']],
  ["type + '_empty: el artifact ' + deps[0].artifactId + ' está vacío'", ['dynamic_context_package_json_empty: el artifact a está vacío']],
  // EXAM_BANK_CHAPTER_MD_MISSING (las dos asignaciones literales de mdErr).
  ['mdErr', ['EXAM_BANK_CHAPTER_MD_MISSING: el capítulo c llegó con 2 artifacts dynamic_content_md (se esperaba 1)',
    'EXAM_BANK_CHAPTER_MD_MISSING: no se pudo leer el texto del capítulo c (vacío)']],
  // Pasamanos: el texto lo arman OTROS emisores que el gate ya escanea (fail('…'), msg: '…', api()).
  ['error', []], ['msg', []], ['e.msg', []], ['result.error', []], ['mapped.msg', []],
  // Excepción cruda: la arma api() (04-api.js, escaneado abajo); una excepción JS cualquiera queda desconocida → D retenido.
  ['(e && e.message) || String(e)', []],
  // cursia#68 (#583 N4): reintento de la descarga DENTRO del item. Envuelve el error interno con «(tras N intentos)»:
  // conserva su clase (el código va adelante) y el piso de dinero sigue mirando el texto completo.
  ["err + ' (tras ' + attempt + ' intentos)'", ['text_fetch_failed (tras 3 intentos)', 'download_url_failed (tras 3 intentos)', 'sign_failed (tras 3 intentos)',
    'fetch failed (tras 3 intentos)', 'unsupported_download_method (tras 2 intentos)', 'artifact_download_unavailable (tras 2 intentos)']],
]);

/** Expresiones NO literales de `msg:` en api() (04-api.js), revisadas (texto exacto) → mensajes que producen. */
const FE_API_EXPR_SAMPLES = new Map([
  // cursia#68: error dentro del stream SSE (overloaded/rate_limit → 529; otro → 500).
  ["(overloaded?'Servidor ocupado':'Error del servidor')+' (stream: '+st.error+'). Reintentando…'",
    ['Servidor ocupado (stream: overloaded_error). Reintentando…', 'Error del servidor (stream: api_error). Reintentando…']],
  // cursia#68: el stream dejó de responder / se cortó la conexión.
  ["(idled?'La IA dejó de responder ('+Math.round(API_STREAM_IDLE_MS/1000)+' s sin datos)':'Se cortó la conexión con la IA')+'. Reintentando…'",
    ['La IA dejó de responder (90 s sin datos). Reintentando…', 'Se cortó la conexión con la IA. Reintentando…']],
  // Pasamanos: los mensajes de _apiSseResult (escaneados como literales/expresiones arriba).
  ['se.msg', []],
  ["se2.msg||'Respuesta de la IA incompleta'", ['Respuesta de la IA incompleta']],
]);

/** Corre el gate frontend sobre un directorio; devuelve {missing, samples}. */
function frontendGate(dir, opts = {}) {
  const exec = path.join(dir, 'src/js/45-dynamic-generation-executor.js');
  const api = path.join(dir, 'src/js/04-api.js');
  assert(fs.existsSync(exec) && fs.existsSync(api), 'no existe el ejecutor/api en ' + dir);
  const entries = SCAN.scanFrontendExecutor(exec);
  if (!opts.fixture) assert(entries.length >= 60, 'muy pocos mensajes del ejecutor: ' + entries.length);
  const missing = [];
  const samples = [];
  for (const e of entries) {
    if (e.text.startsWith('__errorCode__ ')) { const c = e.text.slice(14); if (!FC.isFailureCodeClassified(c)) missing.push(`L${e.line} errorCode ${c}`); continue; }
    if (e.text.startsWith('__expr__ ')) {
      const expr = e.text.slice(9);
      if (!FE_EXPR_SAMPLES.has(expr)) { missing.push(`L${e.line} expresión sin código: ${expr.slice(0, 140)}`); continue; }
      for (const x of FE_EXPR_SAMPLES.get(expr)) samples.push([e.line, x]);
      continue;
    }
    samples.push([e.line, e.text]);
  }
  for (const e of SCAN.scanFrontendApi(api)) {
    if (!e.text.startsWith('__expr__ ')) { samples.push([`api:${e.line}`, e.text]); continue; }
    const expr = e.text.slice(9);
    if (!FE_API_EXPR_SAMPLES.has(expr)) { missing.push(`api:${e.line} expresión sin código: ${expr.slice(0, 160)}`); continue; }
    for (const x of FE_API_EXPR_SAMPLES.get(expr)) samples.push([`api:${e.line}`, x]);
  }
  // Prefijos literales que el código completa con un número (mismo texto real que arma el navegador).
  const complete = (t) => (/Fall[oó] despu[eé]s de $/.test(t) ? t + '3 intentos: x' : /\($/.test(t) ? t + '503). Reintentando…' : t);
  for (const [line, raw] of samples) {
    const x = complete(raw);
    // Muestras de un pasamanos de excepción de red ('fetch failed'): desconocidas a propósito para el texto crudo, pero clasificadas como transporte.
    const r = FC.classifyFailure({ error: x.endsWith(' ') ? x + 'x' : x, source: 'browser_executor' });
    if (r.unclassified) missing.push(`L${line} «${x.slice(0, 100)}» → ${r.code}`);
  }
  return { missing, samples, entries };
}

// Auto-test del escáner (M8c): las construcciones que la review mostró invisibles TIENEN que detectarse.
check('gate auto-test (backend): rama, ternario+template, helper, parámetro, parcial, desestructuración, parámetro con default, alias/bind, ?.(, corchetes, spread, template con sufijo y fail(<otro>, …) → detectados', () => {
  const fx = SCAN.scanBackendEmitters(path.join(__dirname, 'fixtures/rel-gate/be'));
  const byLine = fx.emitters.map((e) => ({ ...e, unclassifiedCodes: (e.codes || []).filter((c) => !FC.isFailureCodeClassified(c)) }));
  const flagged = byLine.filter((e) => !e.codes || e.unclassifiedCodes.length > 0);
  assert(fx.emitters.length === 13, 'emisores del fixture: ' + fx.emitters.length);
  assert(flagged.length === 13, 'NO detectados: ' + JSON.stringify(byLine.filter((e) => !flagged.includes(e)).map((e) => [e.line, e.expr, e.codes])));
  for (const needle of ['__indirect__ failItem.bind', '__indirect__ failItem?.(', "__indirect__ ['failItem']", '__args__ ...args', '`lease_expired${s}`']) {
    assert(byLine.some((e) => e.expr.startsWith(needle) && !e.codes), 'caso barato no detectado: ' + needle);
  }
  assert(byLine.some((e) => (e.codes || []).includes('zz_rp_code')), 'fail(d, …) del worker de proveedores');
  const codes = new Set(byLine.flatMap((e) => e.codes || []));
  assert(codes.has('videogen_paid_maybe_new') && codes.has('lease_expired') && codes.has('tpl_new_code_be'), 'unión de ramas: ' + [...codes].join(','));
});

check('gate auto-test (frontend): template, comillas dobles, variable, failWithDraft, backendDynFail, msg lanzado, shorthand, clave computada, X.error = y window.backendDynFail → detectados', () => {
  const { missing } = frontendGate(path.join(__dirname, 'fixtures/rel-gate/fe'), { fixture: true });
  for (const needle of ['brand_new_code', 'expresión sin código: m', 'tpl_new_code', 'dq_new_code', "e.reason + ' algo'", 'bk_new_code', 'thrown_new_code',
    'shorthand:error', 'computed:', 'zz_member_code', 'zz_window_code']) {
    assert(missing.some((x) => x.includes(needle)), `no detectado: ${needle}\n${missing.join('\n')}`);
  }
});

if (FE_DIR) {
  check(`gate frontend (${path.relative(process.cwd(), FE_DIR) || FE_DIR}): cada mensaje de fallo del ejecutor y de api() se clasifica explícitamente`, () => {
    const { missing, samples } = frontendGate(FE_DIR);
    assert(missing.length === 0, 'mensajes del navegador sin regla / expresiones sin código:\n' + missing.join('\n'));
    console.log(`   (${samples.length} mensajes del navegador)`);
  });
} else if (process.argv.includes('--require-fe')) {
  check('gate frontend: --require-fe sin --fe <dir>', () => { throw new Error('el gate frontend es obligatorio aquí (CI): pasar --fe <checkout del frontend>'); });
} else {
  console.log('ℹ️  gate frontend omitido (sin --fe <dir del frontend>; en CI corre con --require-fe --fe)');
}

console.log(`\n${failures === 0 ? '✅' : '❌'} check-rel-failure-classes: ${passes} ok, ${failures} fallidos`);
process.exit(failures === 0 ? 0 : 1);
