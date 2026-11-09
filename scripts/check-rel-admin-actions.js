#!/usr/bin/env node
/* eslint-disable */
// r106 — el `adminAction` de CADA regla del clasificador central (src/modules/reliability/failure-classifier.ts) tiene que
// ser ejecutable en el estado en que el fallo deja la parte. Antes: EXAM_BANK_LEAF_CAPACITY / EXAM_BANK_SET_RULE_CAPACITY
// (y el contrato roto, EXAM_BANK_CLAIM, EXAM_BANK_CHAPTER_MD_MISSING de contrato) → `regenerate_item` sobre una parte
// `failed`, que regenerateItem rechaza (item_not_completed); YouTube no ambiguo → `resolve_youtube`, que youtube-resolution
// rechaza (not_ambiguous); provider_reconciliation_required en un video → `reconcile_provider` (resubmitProvider no admite
// videos).
//
// Puro (sin DB, sin red, USD 0):
//   1. las compuertas de estado que usa RunsService viven en dynamic-generation/admin-action-eligibility.ts y
//      runs.service.ts las usa (escaneo del fuente: retry / regenerate / resubmitProvider / resubmitVideo / youtube);
//   2. cada acción va al endpoint que esas compuertas protegen (endpointForAction de admin-recovery.service);
//   3. barrido: cada código clasificado × tipos de parte realistas × output_summary relevante → veredicto → estado tras
//      el fallo (`failed`, o `blocked` por presupuesto; paquete `failed`) → ¿la acción es ejecutable? Toda regla del
//      clasificador queda cubierta; una acción no ejecutable falla salvo que esté en KNOWN_DEAD_ENDS (con su motivo), y
//      una entrada de KNOWN_DEAD_ENDS que ya no aparece también falla (lista vieja);
//   4. casos de regresión de r106.
//
// Uso: npm run build && node scripts/check-rel-admin-actions.js [--table] [path/to/dist]
//   --table imprime la tabla regla → estado → acción → ¿ejecutable? (Markdown).

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const PRINT_TABLE = args.includes('--table');
const distArg = args.find((a) => !a.startsWith('--'));
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
const E = loadDist('modules/dynamic-generation/admin-action-eligibility.js');
const AR = loadDist('modules/dynamic-generation/admin-recovery.service.js');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.log(`❌ ${name}\n   ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`);
}

// ─── Modelo de ejecutabilidad (las MISMAS compuertas que RunsService) ─────────
const PROVIDER_TYPES = ['presentation', 'audio_welcome', 'audiobook_chapter'];
const LLM_TYPES = ['content', 'exam', 'final_exam', 'video_interactions', 'activity', 'application_activity'];
const ALL_TYPES = [...LLM_TYPES, 'video', ...PROVIDER_TYPES];

function sourceOf(type) {
  return type === 'video' ? 'video_worker' : PROVIDER_TYPES.includes(type) ? 'provider_worker' : 'browser_executor';
}

/**
 * ¿El endpoint de `action` (endpointForAction) acepta la parte en este estado? `row` = { type, status, error, output_summary }.
 * Los videos se suponen de un run con entrega por YouTube (el caso más estricto del retry: rechaza la subida ambigua).
 */
function executable(action, row, scope) {
  if (scope === 'package') return action === 'retry_package' || action === 'resolve_package_block';
  const retryOk = E.retryAcceptsItem(row) && !(row.type === 'video' && E.isAmbiguousYoutubeUpload(row));
  switch (action) {
    case 'retry_item':
    case 'approve_budget':
      return retryOk;
    case 'regenerate_item':
      return E.regenerateAcceptsStatus(row.status);
    case 'reconcile_provider':
      return E.retryAcceptsItem(row) && E.RESUBMIT_PROVIDER_ITEM_TYPES.includes(row.type) && E.resubmitProviderErrorEligible(row.type, row.error);
    case 'reconcile_videogen':
    case 'retry_video_render':
      return E.retryAcceptsItem(row) && row.type === 'video' && E.manualResubmitVideoEligible(row.error, row.output_summary);
    case 'resolve_youtube':
      return row.type === 'video' && row.status === 'failed' && E.isAmbiguousYoutubeUpload(row);
    default:
      return false;
  }
}

/** Estados en que el fallo deja la parte: `failed`; además `blocked` por el guard de presupuesto (budget_exceeded). */
function statesAfter(error) {
  return String(error).startsWith('budget_exceeded') ? ['failed', 'blocked'] : ['failed'];
}

/**
 * Callejones sin salida CONOCIDOS (clave regla|acción|tipo): ninguna acción de admin ejecutable hoy sin decidir un cambio en
 * un camino de dinero. Cada uno lleva su motivo; si deja de aparecer, el check falla (sacarlo de la lista).
 */
const KNOWN_DEAD_ENDS = {
  // fix round 2 (N5): con trozos de TTS ya pagados la acción NUNCA es retry_item (no se garantiza no repagar), pero
  // resubmitProvider solo admite `provider_reconciliation_required` / Gamma: `tts_failed: chunk N/M …` queda sin reenvío
  // explícito. Decisión pendiente: admitir ese prefijo en resubmitProviderErrorEligible para audio.
  'tts_failed|reconcile_provider|audio_welcome': 'N5: tts_failed con trozos pagados → resubmitProvider no admite el prefijo tts_failed',
  'tts_failed|reconcile_provider|audiobook_chapter': 'N5: tts_failed con trozos pagados → resubmitProvider no admite el prefijo tts_failed',
  // Piso de dinero (N2) sobre un error SIN prefijo de reenvío en una parte de proveedor / video: ningún reenvío explícito lo
  // admite. El worker de proveedores ya reescribe el fallo con dinero en el aire a provider_reconciliation_required (fail());
  // queda el texto libre de un `unexpected_error`. Misma decisión pendiente que N5.
  'unexpected_error|reconcile_provider|presentation': 'piso de dinero sin prefijo de reenvío (resubmitProvider no lo admite)',
  'unexpected_error|reconcile_provider|audio_welcome': 'piso de dinero sin prefijo de reenvío (resubmitProvider no lo admite)',
  'unexpected_error|reconcile_provider|audiobook_chapter': 'piso de dinero sin prefijo de reenvío (resubmitProvider no lo admite)',
  'unexpected_error|reconcile_videogen|video': 'piso de dinero sin prefijo de reenvío (resubmitVideo no lo admite)',
  // r62 (N2): mientras la conciliación con Videogen decide, la acción de admin no se muestra (adminActionFor → null); la
  // de admin solo es ejecutable con la excepción registrada para ESE error (cubierta con output_summary.providerReconcile).
  'videogen_render_overdue|retry_video_render|video': 'esperando la conciliación automática (la acción aparece solo con la excepción registrada)',
};

/**
 * Variantes de output_summary en que ese fallo puede dejar la parte: la subida a YouTube (ambigua o no) solo en fallos de
 * YouTube; la excepción de conciliación registrada para ESE error solo en fallos de Videogen.
 */
function osVariants(type, error, verdict) {
  if (type !== 'video') return [{}];
  const base = { external: { videogenJobId: 'vg' } };
  if (verdict.provider === 'youtube') {
    return [base,
      { ...base, delivery: 'ambiguous', youtubeUploadStartedAt: '2026-11-07T00:00:00Z' },
      { ...base, delivery: 'blocked_auth', youtubeUploadStartedAt: '2026-11-07T00:00:00Z' }];
  }
  if (verdict.provider === 'videogen') return [base, { ...base, providerReconcile: { declined: 'provider_stuck_no_cancel', declinedError: error } }];
  return [base];
}

/**
 * Códigos de la tabla que NO llegan como error de una parte (los 409 de los endpoints y motivos de liquidación del ledger,
 * más los alias que ningún emisor produce): el barrido no los usa como fallo de una parte.
 */
const NOT_ITEM_ERRORS = new Set([
  'confirm_paid_required', // 409 de regenerateItem (confirmar el gasto)
  'may_have_rendered_ack_required', // 409 de la conciliación de reservas de Videogen
  'video_upgrade_ambiguous_submission', // blocker (409) del upgrade de videos
  'reserved_without_submit_marker', // motivo de liquidación de una reserva (ledger)
  'ambiguous_gamma_submission', // alias: el worker emite gamma_submit_ambiguous
]);

/** Tipos de parte que pueden fallar con esa regla (por el proveedor del veredicto); sin proveedor: cualquiera. */
function realisticTypes(verdict) {
  switch (verdict.provider) {
    case 'videogen': case 'youtube': return ['video'];
    case 'gamma': return ['presentation'];
    case 'openai': return ['audio_welcome', 'audiobook_chapter'];
    case 'anthropic': return [...LLM_TYPES, 'audiobook_chapter'];
    default: return ALL_TYPES;
  }
}

// Muestras de las reglas que solo tienen familia (regex) o cuyo caso interesante es una variante (refine).
const FAMILY_SAMPLES = [
  'EXAM_BANK_LEAF_CAPACITY: ch1 × multichoice 3/8 (24 candidatas, 20 con la estrategia alternativa; motivo EXAM_BANK_EVIDENCE)',
  'EXAM_BANK_SET_RULE_CAPACITY: la correcta es la opción más larga en 9/20 MC (máx. 30 %; excedente 3)',
  'EXAM_BANK_CLAIM: el claim no trae examBank', 'EXAM_BANK_INCOMPLETE: hojas por debajo del piso',
  'EXAM_BANK_CHAPTER_MD_MISSING: el capítulo llegó con 2 artifacts (se esperaba 1)',
  'EXAM_BANK_CHAPTER_MD_MISSING: no se pudo descargar',
  'llm_request_rejected: prompt is too long', 'gamma_generation_failed: x [créditos medidos: 40]. No se reenvía sola',
  'tts_failed: chunk 3/4: HTTP 503', 'tts_failed: chunk 2/4: HTTP 401: Incorrect API key', 'tts_failed: chunk 1/4: HTTP 429: insufficient_quota',
  'provider_reconciliation_required: openai — audio. x', 'provider_reconciliation_required: videogen — render. x',
  'provider_reconciliation_required: gamma — generación. x',
  'unexpected_error: budget_exceeded: tope', 'unexpected_error: reconciliation pendiente (ambiguous)',
  'claim_payload_unavailable: video_interactions sin el video del capítulo',
  'pdf_download_failed: x', 'missing_content_artifact', 'GIFT_EMPTY: x', 'MP3_BROKEN: x', 'PDF_BROKEN: x',
  'provider_mode_video: x', 'GAMMA_THEME_X: x', 'APPLICATION_X: x', 'GUIDED_PRACTICE_X: x', 'context_empty: x',
];
const PACKAGE_SAMPLES = [
  'MBZ_V3_VALIDATION_FAILED', 'H5P_PACKAGE_BROKEN', 'Supabase Storage upload failed: 403 forbidden', 'Supabase Storage upload failed: 503',
];
const RESTORE_SAMPLES = ['RESTORE_INFRA_TIMEOUT', 'RESTORE_EXECUTE_FAILED', 'RESTORE_PRECHECK_ERROR'];

// ─── 1. RunsService usa las compuertas compartidas ────────────────────────────
check('RunsService usa las compuertas de admin-action-eligibility (retry / regenerate / resubmitProvider / resubmitVideo / youtube-resolution)', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/modules/dynamic-generation/runs.service.ts'), 'utf8');
  for (const needle of [
    "from './admin-action-eligibility'",
    'if (!retryAcceptsItem(target))',
    'if (!regenerateAcceptsStatus(latest.status))',
    'const eligible = resubmitProviderErrorEligible(target.type, err);',
    'const eligible = manualResubmitVideoEligible(err, target.output_summary)',
    "pre.status !== 'failed' || !isAmbiguousYoutubeUpload(pre)",
    'if (!RESUBMIT_PROVIDER_ITEM_TYPES.includes(target.type))',
  ]) assert(src.includes(needle), `runs.service.ts ya no contiene «${needle}» (la compuerta se duplicó o cambió: actualizar admin-action-eligibility.ts y este check)`);
  for (const dup of ['function isAmbiguousYoutubeUpload(', 'function isBudgetBlocked(']) {
    assert(!src.includes(dup), `runs.service.ts vuelve a definir ${dup}…) — usar el de admin-action-eligibility.ts`);
  }
});

// ─── 2. Cada acción va al endpoint que esas compuertas protegen ──────────────
check('endpointForAction: cada acción del clasificador apunta al endpoint modelado', () => {
  const ids = { courseId: 1, blueprintNumber: 1, runId: 'r' };
  const ep = (code) => AR.endpointForAction({ code, itemKey: 'k' }, ids);
  assert(/\/items\/k\/retry$/.test(ep('retry_item').path) && JSON.stringify(ep('retry_item').body) === '{}', 'retry_item → POST …/retry {}');
  assert(/\/items\/k\/retry$/.test(ep('approve_budget').path) && /authorizations$/.test(ep('approve_budget').before.path), 'approve_budget → autorización + …/retry');
  assert(/\/items\/k\/regenerate$/.test(ep('regenerate_item').path), 'regenerate_item → …/regenerate');
  assert(/\/items\/k\/retry$/.test(ep('reconcile_provider').path) && ep('reconcile_provider').body.resubmitProvider === true, 'reconcile_provider → retry resubmitProvider');
  for (const c of ['reconcile_videogen', 'retry_video_render']) assert(/\/items\/k\/retry$/.test(ep(c).path) && ep(c).body.resubmitVideo === true, `${c} → retry resubmitVideo`);
  assert(/\/items\/k\/youtube-resolution$/.test(ep('resolve_youtube').path), 'resolve_youtube → …/youtube-resolution');
  for (const c of ['retry_package', 'resolve_package_block']) assert(/\/runs\/r\/package$/.test(ep(c).path), `${c} → …/package`);
});

// ─── 3. Barrido ──────────────────────────────────────────────────────────────
const ruleIds = FC.classifierRuleIds();
const rows = new Map(); // clave regla|acción|tipo → fila de la tabla
const deadEnds = new Map();
const seenRules = new Set();
const missingAction = [];

function record(scope, verdict, type, state, os, error) {
  seenRules.add(`${scope === 'package' ? (ruleIds.restore.includes(verdict.rule) ? 'restore' : 'package') : 'item'}:${verdict.rule}`);
  if (verdict.strategy === 'hold_for_human' && !verdict.adminAction) missingAction.push(`${verdict.rule} (${verdict.code}, ${type})`);
  if (!verdict.adminAction) return;
  const row = { type, status: state, error, output_summary: os };
  const ok = executable(verdict.adminAction, row, scope);
  const key = `${verdict.rule}|${verdict.adminAction}|${scope === 'package' ? 'package' : type}`;
  const prev = rows.get(key);
  // Una misma regla|acción|tipo puede ser ejecutable en una variante y no en otra (p.ej. YouTube ambiguo o no): se
  // registra el peor caso con su ejemplo.
  if (!prev || (prev.ok && !ok)) {
    rows.set(key, { rule: verdict.rule, cls: verdict.class, code: verdict.code, scope, type: scope === 'package' ? '—' : type, state: scope === 'package' ? 'paquete failed' : state, action: verdict.adminAction, ok, os });
  }
  if (!ok) deadEnds.set(key, `${verdict.code} [${type}, ${state}${Object.keys(os).length ? `, os=${JSON.stringify(os)}` : ''}]`);
}

const itemCodes = FC.classifiedCodes();
const itemMessages = [...itemCodes.filter((c) => !NOT_ITEM_ERRORS.has(c)).map((c) => `${c}: x`), ...FAMILY_SAMPLES];
for (const msg of itemMessages) {
  for (const type of ALL_TYPES) {
    const probe = FC.classifyFailure({ error: msg, itemType: type, source: sourceOf(type), outputSummary: {} });
    if (probe.unclassified || !ruleIds.item.includes(probe.rule)) continue;
    if (!realisticTypes(probe).includes(type)) continue;
    for (const os of osVariants(type, msg, probe)) {
      const v = FC.classifyFailure({ error: msg, itemType: type, source: sourceOf(type), outputSummary: os });
      for (const state of statesAfter(msg)) record('item', v, type, state, os, msg);
    }
  }
}
for (const msg of [...itemCodes, ...PACKAGE_SAMPLES]) {
  const v = FC.classifyFailure({ source: 'package_worker', error: msg });
  if (!v.unclassified && ruleIds.package.includes(v.rule)) record('package', v, 'package', 'failed', {}, msg);
}
for (const msg of [...itemCodes, ...RESTORE_SAMPLES]) {
  const v = FC.classifyFailure({ source: 'restore_worker', error: msg });
  if (!v.unclassified && ruleIds.restore.includes(v.rule)) record('package', v, 'package', 'failed', {}, msg);
}

check('barrido: cada regla del clasificador (item / paquete / restauración) queda cubierta', () => {
  const all = [...ruleIds.item.map((r) => `item:${r}`), ...ruleIds.package.map((r) => `package:${r}`), ...ruleIds.restore.map((r) => `restore:${r}`)];
  const missing = all.filter((r) => !seenRules.has(r));
  assert(!missing.length, `reglas sin muestra en el barrido (agregar a FAMILY_SAMPLES / PACKAGE_SAMPLES / RESTORE_SAMPLES): ${missing.join(', ')}`);
  console.log(`   (${rows.size} combinaciones regla × acción × tipo, ${seenRules.size} reglas)`);
});

check('barrido: toda retención para una persona (hold_for_human) lleva una acción de admin', () => {
  assert(!missingAction.length, `sin adminAction: ${[...new Set(missingAction)].slice(0, 10).join('; ')}`);
});

check('barrido: cada acción de admin es ejecutable en el estado que deja el fallo (salvo KNOWN_DEAD_ENDS, con motivo)', () => {
  const unexpected = [...deadEnds.entries()].filter(([k]) => !KNOWN_DEAD_ENDS[k]);
  assert(!unexpected.length, `acciones NO ejecutables:\n     ${unexpected.map(([k, ex]) => `${k} ← ${ex}`).join('\n     ')}`);
  const stale = Object.keys(KNOWN_DEAD_ENDS).filter((k) => !deadEnds.has(k));
  assert(!stale.length, `KNOWN_DEAD_ENDS que ya no aparecen (sacarlos de la lista): ${stale.join(', ')}`);
  console.log(`   (${deadEnds.size} callejones conocidos: ${[...deadEnds.keys()].join(', ')})`);
});

check('barrido: ningún fallo de una parte apunta a regenerate_item (regenerateItem solo acepta una parte completed)', () => {
  const bad = [...rows.values()].filter((r) => r.scope === 'item' && r.action === 'regenerate_item');
  assert(!bad.length, bad.map((r) => `${r.rule} (${r.code})`).join(', '));
});

// ─── 4. Regresiones r106 ─────────────────────────────────────────────────────
const exam = (error, os = {}) => FC.classifyFailure({ error, itemType: 'final_exam', source: 'browser_executor', outputSummary: os });
check('r106: EXAM_BANK_SET_RULE_CAPACITY / LEAF_CAPACITY / CLAIM → D retenido con retry_item (ejecutable sobre la parte failed)', () => {
  for (const [msg, reason] of [[FAMILY_SAMPLES[0], 'unrecoverable'], [FAMILY_SAMPLES[1], 'unrecoverable'], ['EXAM_BANK_CLAIM: x', 'product_bug']]) {
    const v = exam(msg);
    eq([v.class, v.strategy, v.humanReason, v.adminAction], ['D', 'hold_for_human', reason, 'retry_item'], msg.slice(0, 40));
    assert(executable(v.adminAction, { type: 'final_exam', status: 'failed', error: msg, output_summary: {} }), `${v.code}: no ejecutable`);
    assert(!executable('regenerate_item', { type: 'final_exam', status: 'failed', error: msg, output_summary: {} }), 'regenerate_item sobre failed tiene que seguir siendo 409');
  }
  eq(exam('EXAM_BANK_CHAPTER_MD_MISSING: llegó con 2 artifacts').adminAction, 'retry_item', 'chapter_md contrato');
  eq(FC.classifyFailure({ error: 'missing_content_artifact', itemType: 'exam' }).adminAction, 'retry_item', 'contrato');
});
check('r106: YouTube — subida ambigua → resolve_youtube; no ambigua (auth / cuota / rechazo) → retry_item (re-sube sin re-renderizar)', () => {
  for (const err of ['youtube_blocked_auth: token revocado', 'youtube_quota_exhausted: 7 días', 'youtube_upload_rejected: invalidTitle', 'ambiguous_youtube_upload: x']) {
    const plain = FC.classifyFailure({ error: err, itemType: 'video', source: 'video_worker', outputSummary: { delivery: 'blocked_auth', external: { videogenJobId: 'vg' } } });
    const amb = FC.classifyFailure({ error: err, itemType: 'video', source: 'video_worker', outputSummary: { delivery: 'ambiguous', youtubeUploadStartedAt: 'x' } });
    eq([plain.adminAction, amb.adminAction], [err.startsWith('ambiguous_') ? 'resolve_youtube' : 'retry_item', 'resolve_youtube'], err.slice(0, 30));
  }
});
check('r106: provider_reconciliation_required → la conciliación del tipo (video: resubmitVideo; IA: retry_item; proveedor: resubmitProvider)', () => {
  const c = (type, err) => FC.classifyFailure({ error: err, itemType: type, source: sourceOf(type) }).adminAction;
  eq(c('video', 'provider_reconciliation_required: videogen — render. x'), 'reconcile_videogen', 'video');
  eq(c('presentation', 'provider_reconciliation_required: gamma — x'), 'reconcile_provider', 'presentación');
  eq(c('audio_welcome', 'provider_reconciliation_required: openai — x'), 'reconcile_provider', 'audio');
  eq(c('content', 'provider_reconciliation_required: anthropic — x'), 'retry_item', 'IA');
  // Sin tipo (p.ej. códigos sueltos de las vistas) se conserva la acción de la regla.
  eq(FC.classifyFailure({ error: 'provider_reconciliation_required: x' }).adminAction, 'reconcile_provider', 'sin tipo');
});
check('r106: piso de dinero → la conciliación ejecutable para el tipo (IA → retry_item; sin tipo → reconcile_provider)', () => {
  const m = 'unexpected_error: el envío quedó ambiguous';
  const ia = FC.classifyFailure({ error: m, itemType: 'content', source: 'browser_executor' });
  eq([ia.class, ia.moneyFloor, ia.adminAction], ['C', true, 'retry_item'], 'IA');
  eq(FC.classifyFailure({ error: m }).adminAction, 'reconcile_provider', 'sin tipo');
});
check('r106: compuertas puras (retry acepta failed y blocked por presupuesto; regenerate solo completed)', () => {
  eq([E.retryAcceptsItem({ status: 'failed' }), E.retryAcceptsItem({ status: 'blocked', error: 'budget_exceeded: x' }), E.retryAcceptsItem({ status: 'blocked', error: 'dep' }), E.retryAcceptsItem({ status: 'completed' })],
    [true, true, false, false], 'retry');
  eq([E.regenerateAcceptsStatus('completed'), E.regenerateAcceptsStatus('failed')], [true, false], 'regenerate');
  eq(E.manualResubmitVideoEligible('videogen_render_overdue: x', {}), false, 'overdue sin excepción');
  eq(E.manualResubmitVideoEligible('videogen_render_overdue: x', { providerReconcile: { declined: 'y', declinedError: 'videogen_render_overdue: x' } }), true, 'overdue con su excepción');
  eq(E.manualResubmitVideoEligible('videogen_render_overdue: x', { providerReconcile: { declined: 'y', declinedError: 'videogen_render_overdue: otro' } }), false, 'excepción de otro error');
});

if (PRINT_TABLE) {
  const list = [...rows.values()].sort((a, b) => (a.scope + a.rule + a.type).localeCompare(b.scope + b.rule + b.type));
  console.log('\n| regla | clase | estado tras el fallo | tipo | adminAction | ¿ejecutable? |');
  console.log('|---|---|---|---|---|---|');
  for (const r of list) {
    const k = `${r.rule}|${r.action}|${r.scope === 'package' ? 'package' : r.type}`;
    console.log(`| ${r.rule} | ${r.cls} | ${r.state} | ${r.type} | ${r.action} | ${r.ok ? 'sí' : `NO — ${KNOWN_DEAD_ENDS[k] ?? 'sin motivo'}`} |`);
  }
}

console.log(`\n${failures ? '❌' : '✅'} check-rel-admin-actions: ${passes} ok, ${failures} fallidos`);
process.exit(failures ? 1 : 0);
