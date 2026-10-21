#!/usr/bin/env node
/* eslint-disable */
// r62 (agente N1) — recuperación automática bajo la REGLA DE AMBIGÜEDAD ACOTADA (fix-common.md). Un caso por punto:
//   K1/c1/d10  TTS de OpenAI vencido o ambiguo: timeout del cliente por encima de la cola observada; si igual vence →
//              reserva liquidada como `charged` + `possible_duplicate` (actor system) y UN reenvío solo del segmento
//              afectado, con el peor caso dentro del presupuesto de la parte y del saldo autorizado (sin tope fijo 0,10).
//              Reproducción de #1510: el TTS vence → el curso termina solo, a lo sumo 1 reenvío, ledger ≤ autorizado.
//   K2         un HTTP 5xx con cuerpo («504: upstream request timeout») no es un timeout del cliente: resultado conocido,
//              reserva liberada, reintento con backoff (clase A).
//   K6         el clasificador / currentRecovery / attention_reason dicen lo que de verdad pasa.
//   c4         LLM con resultado desconocido (Anthropic): misma regla del punto 3 (un reenvío por parte, con presupuesto,
//              reserva perdida liquidada como posible duplicado); Q-21 (hand-back + adopción tardía) sigue delante.
//   d2         clase A sin gasto: ya no va a un humano por 5 rondas / 24 h → backoff largo hasta 72 h (alerta a las 48 h).
//   d3         los dependientes se desbloquean solos cuando se resuelve la causa.
//   d8         claim_payload_unavailable → regenerate_dependency automático (una vez, dentro del presupuesto).
//   K3         kill switch / allow-list de FinOps revertidos → las partes frenadas se reabren solas.
//
// USD 0: proveedores FALSOS en 127.0.0.1 (test/e2e-v2/fakes.js) y PG16 descartable (puerto libre ≠ 5570). Correr con
// netguard: NODE_OPTIONS=--require test/e2e-v2/netguard.js. Contra dist/ (npm run build).
//
// Usage: node scripts/check-r62-recovery.js [--pure-only] [path/to/dist]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const AH = loadDist('modules/dynamic-generation/auto-heal.js');
const FC = loadDist('modules/reliability/failure-classifier.js');
const SG = loadDist('modules/finops/run-spend-guard.js');
const AR = loadDist('modules/finops/ambiguous-resend.js');
const SCH = loadDist('modules/reliability/spend-control-hold.js');
const CPR = loadDist('modules/reliability/claim-payload-recovery.js');
const PC = loadDist('workers/provider-real/provider-clients.js');
const RP = loadDist('workers/provider-real/real-providers.js');
const LT = loadDist('workers/lease-takeover.js');
const SL = loadDist('workers/llm-executor/server-llm.js');
const PW = loadDist('workers/dynamic-provider-worker.js');
const WD = loadDist('workers/worker-drain.js');
const RC = loadDist('modules/dynamic-generation/run-completion.js');
const F = loadDist('modules/finops/index.js');
const SM = loadDist('package/v3/synthetic-media.js');
const { startStorage, startProviderFakes } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));

const SECRETS = {
  GAMMA_API_KEY: 'sk-r62-gamma-SECRET-1a2b3c', OPENAI_API_KEY: 'sk-r62-openai-SECRET-4d5e6f',
  ANTHROPIC_API_KEY: 'sk-r62-anthropic-SECRET-7a8b9c', VIDEOGEN_API_KEY: 'sk-r62-videogen-SECRET-0d1e2f',
};
const LOGS = [];
const capLogger = { log: (m) => LOGS.push(String(m)), warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)) };
Logger.overrideLogger({ log: capLogger.log, warn: capLogger.warn, error: capLogger.error, debug: () => {}, verbose: () => {} });

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
async function rejectsRe(p, re, msg, status) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
  assert(re.test(text), `${msg}: mensaje inesperado "${text.slice(0, 600)}"`);
  if (status !== undefined) assert(err.getStatus && err.getStatus() === status, `${msg}: status ${err.getStatus && err.getStatus()} (esperado ${status})`);
  return err;
}

const RECON = 'provider_reconciliation_required: openai — llamada pagada enviada sin resultado liquidado:';
const NOW = new Date('2026-10-19T15:20:00Z');
const rowOf = (error, type = 'audiobook_chapter', o = {}) => ({
  id: o.id || 'r62-item', status: 'failed', type, error, output_summary: o.os || {}, finished_at: new Date(NOW.getTime() - (o.secAgo ?? 300) * 1000).toISOString(),
  failure_class: o.cls ?? null,
});
const FITS = { budget: { fits: true, reason: null } };
const PENDING = { pendingUsd: 0.0735, providers: ['openai'], resendUsd: 0.0735 };

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  await check('K1 (punto 1, prevenir): el timeout del cliente TTS supera la cola observada (172 s) y queda por debajo del lease (300 s) y del drenado (270 s); la ventana en vuelo de Q-21 se deriva de él', () => {
    assert(PC.OPENAI_TTS_TIMEOUT_MS > 172_000, `timeout ${PC.OPENAI_TTS_TIMEOUT_MS}`);
    assert(PC.OPENAI_TTS_TIMEOUT_MS < PW.PROVIDER_WORKER_MIN_LEASE_SECONDS * 1000, 'debajo del lease del worker');
    assert(PC.OPENAI_TTS_TIMEOUT_MS < WD.DEFAULT_DRAIN_TIMEOUT_MS, 'debajo del drenado');
    eq(LT.IN_FLIGHT_WINDOW_MS.openai, PC.OPENAI_TTS_TIMEOUT_MS + LT.IN_FLIGHT_MARGIN_MS, 'ventana en vuelo = timeout + margen');
    // M4: PROVIDER_CALL_TIMEOUT_MS (genérico) ya no lo baja del mínimo; solo OPENAI_TTS_TIMEOUT_MS explícito (pruebas / E2E).
    eq(PC.ttsTimeoutMs({}), { ms: PC.OPENAI_TTS_TIMEOUT_MS, source: 'default' }, 'default');
    eq(PC.ttsTimeoutMs({ PROVIDER_CALL_TIMEOUT_MS: '8000' }).ms, PC.OPENAI_TTS_TIMEOUT_MS, 'el timeout genérico no lo acorta');
    eq(PC.ttsTimeoutMs({ PROVIDER_CALL_TIMEOUT_MS: '120000' }).ms, PC.OPENAI_TTS_TIMEOUT_MS, 'ni un 120 s heredado');
    eq(PC.ttsTimeoutMs({ OPENAI_TTS_TIMEOUT_MS: '400' }), { ms: 400, source: 'OPENAI_TTS_TIMEOUT_MS' }, 'override explícito');
    // re-review m4: el override nunca supera lease − margen, y la ventana de takeover se deriva del timeout efectivo.
    eq(PC.ttsTimeoutMs({ OPENAI_TTS_TIMEOUT_MS: '999999' }).ms, PC.OPENAI_TTS_TIMEOUT_MAX_MS, 'override acotado');
    assert(PC.OPENAI_TTS_TIMEOUT_MAX_MS + LT.IN_FLIGHT_MARGIN_MS <= PW.PROVIDER_WORKER_MIN_LEASE_SECONDS * 1000, 'override + margen ≤ lease');
    assert(LT.IN_FLIGHT_WINDOW_MS.openai >= PC.ttsTimeoutMs(process.env).ms + LT.IN_FLIGHT_MARGIN_MS, 'la ventana cubre el timeout efectivo de este proceso');
  });

  await check('K1/d10 (punto 3): el peor caso (gastado con la reserva perdida + la reserva nueva) contra el presupuesto de la parte y el saldo del run — sin tope fijo de USD 0,10', () => {
    assert(AH.AMBIGUOUS_AUDIO_RESUBMIT_MAX_USD === undefined, 'no hay tope fijo');
    const ok = SG.ambiguousResendBudget({ itemSpent: 0.3, nextCost: 0.12, itemHardLimit: 0.5, runSpent: 10, authorizedBudget: 20 });
    eq([ok.fits, ok.reason, Number(ok.worstItem.toFixed(4)), Number(ok.worstRun.toFixed(4))], [true, null, 0.42, 10.12], 'entra (aunque 0.12 > 0.10)');
    eq(SG.ambiguousResendBudget({ itemSpent: 0.45, nextCost: 0.12, itemHardLimit: 0.5, runSpent: 1, authorizedBudget: 20 }).reason, 'item_recovery_budget', 'presupuesto de la parte');
    eq(SG.ambiguousResendBudget({ itemSpent: 0.1, nextCost: 0.12, itemHardLimit: 0.5, runSpent: 19.95, authorizedBudget: 20 }).reason, 'run_budget', 'saldo del run');
    eq(SG.ambiguousResendBudget({ itemSpent: 0, nextCost: 0.01, itemHardLimit: 0.5, runSpent: 0, authorizedBudget: null }).reason, 'no_authorization', 'sin autorización');
    eq(SG.ambiguousResendBudget({ itemSpent: 0, nextCost: 0.01, itemHardLimit: null, runSpent: 0, authorizedBudget: 5 }).reason, 'no_item_estimate', 'sin estimado de la parte');
    // La decisión: timeout del cliente → UN reenvío (antes `timeout_likely_charged` → admin); fuera del presupuesto → excepción.
    const e = `${RECON} tts_failed: chunk 1/7: openai POST /audio/speech: error de red (TimeoutError)`;
    const d = AH.ambiguousAudioResubmitDecision(rowOf(e, 'audio_welcome'), NOW, PENDING, undefined, FITS);
    eq([d.heal, d.round, d.cause], [true, 1, 'timeout_presumed_charged'], 'timeout → reenvío único');
    eq(AH.ambiguousAudioResubmitDecision(rowOf(e), NOW, PENDING, undefined, { budget: { fits: false, reason: 'run_budget' } }).reason, 'over_budget', 'fuera de lo autorizado');
    eq(AH.ambiguousAudioResubmitDecision(rowOf(e, 'audiobook_chapter', { os: { ambiguousAudioResubmit: { rounds: 1 } } }), NOW, PENDING, undefined, FITS).reason, 'cap_reached', 'nunca más de uno por parte');
    eq(AH.ambiguousAudioResubmitDecision(rowOf(e, 'video'), NOW, PENDING, undefined, FITS).reason, 'not_audio', 'video nunca');
  });

  await check('K1 (punto 3, ledger): la reserva perdida se liquida como cobrada con possible_duplicate, actor system y el motivo; repetir = no-op; un fallo de una reserva no tapa a las demás', async () => {
    const calls = [];
    const ledger = {
      async reconcileReservationAsCharged(key, reason, o) {
        calls.push({ key, reason, o });
        if (key === 'boom') throw new Error('db caída');
        return { reconciled: key !== 'done', alreadySettled: key === 'done', amount: '0.02', event: null };
      },
    };
    const r = await AR.settleAmbiguousAsPossibleDuplicate(ledger, ['k1', 'k1', 'done', 'boom'], { provider: 'openai', cause: 'timeout_presumed_charged', itemRunId: 'ir', itemKey: 'audio_welcome:1' });
    eq([r.settled, r.alreadySettled, r.failed.map((x) => x.key)], [['k1'], ['done'], ['boom']], 'resultado');
    const c = calls[0];
    eq([c.o.decidedBy, c.o.metadata.possibleDuplicate, c.o.metadata.auto, c.o.metadata.cause, c.o.metadata.rule], ['system', true, true, 'timeout_presumed_charged', 'r62_bounded_ambiguity'], 'metadata');
    assert(/timeout presumido cobrado/.test(c.reason) && /posible duplicado/.test(c.reason), `motivo: ${c.reason}`);
  });

  await check('K2 + C1: solo un rechazo de admisión (429/503/529) es «conocido, sin cobro»; 500/502/504/524 (p. ej. «504: upstream request timeout») son AMBIGUOS → reconciliación + reenvío único de K1; la regex de timeout no captura el cuerpo de un 5xx', () => {
    const body504 = 'openai POST /audio/speech HTTP 504: upstream request timeout';
    assert(!AH.AMBIGUOUS_AUDIO_TIMEOUT_RE.test(body504), 'la regex del timeout del cliente no captura el cuerpo de un 5xx');
    assert(AH.AMBIGUOUS_AUDIO_TIMEOUT_RE.test('openai POST /audio/speech: error de red (TimeoutError)') && AH.AMBIGUOUS_AUDIO_TIMEOUT_RE.test('The operation was aborted due to timeout'), 'formato de send() / AbortSignal');
    const e = (st) => new PC.ProviderCallError('openai', true, `openai POST /audio/speech HTTP ${st}: x`, st);
    eq([429, 503, 529].map((st) => RP.isKnownTransientHttpError(e(st))), [true, true, true], 'admisión: conocidos');
    eq([500, 502, 504, 524, 408, 409].map((st) => RP.isKnownTransientHttpError(e(st))), [false, false, false, false, false, false], 'ambiguos');
    eq(RP.isKnownTransientHttpError(new PC.ProviderCallError('openai', true, 'openai POST /audio/speech: error de red (TimeoutError)')), false, 'red: ambiguo');
    const vk = FC.classifyFailure({ error: 'tts_failed: chunk 3/5: openai POST /audio/speech HTTP 503: overloaded', itemType: 'audio_welcome', source: 'provider_worker' });
    eq([vk.class, vk.paidRisk], ['A', 'measured'], '503 con trozos cobrados → A (medido)');
    const va = FC.classifyFailure({ error: `tts_failed: chunk 3/5: ${body504}`, itemType: 'audio_welcome', source: 'provider_worker' });
    eq(va.class, 'C', '504 con trozos cobrados → incierto (C)');
    const recon504 = `${RECON} tts_failed: chunk 1/1: ${body504}`;
    const d = AH.ambiguousAudioResubmitDecision(rowOf(recon504, 'audio_welcome'), NOW, PENDING, undefined, FITS);
    eq([d.heal, d.cause], [true, 'connection_cut'], '504 → reenvío único acotado de K1');
  });

  await check('K6: la etiqueta refleja lo que pasa — incierto con reenvío pendiente = auto_resubmit_once / ambiguous_audio_resubmit; usado o rechazado = hold_for_human (duplicate_charge | budget)', () => {
    const e = `${RECON} tts_failed: chunk 1/7 (persisted 0): The operation was aborted due to timeout`;
    const v0 = FC.classifyFailure({ error: e, itemType: 'audiobook_chapter', source: 'provider_worker' });
    eq([v0.class, v0.strategy, FC.currentRecoveryOf(e, 'audiobook_chapter', {})], ['C', 'auto_resubmit_once', 'ambiguous_audio_resubmit'], 'pendiente');
    const v1 = FC.classifyFailure({ error: e, itemType: 'audiobook_chapter', source: 'provider_worker', outputSummary: { ambiguousAudioResubmit: { rounds: 1 } } });
    eq([v1.strategy, v1.humanReason, FC.currentRecoveryOf(e, 'audiobook_chapter', { ambiguousAudioResubmit: { rounds: 1 } })], ['hold_for_human', 'duplicate_charge', 'denied'], 'usado');
    const v2 = FC.classifyFailure({ error: e, itemType: 'audiobook_chapter', source: 'provider_worker', outputSummary: { ambiguousAudioResubmit: { declined: 'over_budget:run_budget' } } });
    eq([v2.strategy, v2.humanReason], ['hold_for_human', 'budget'], 'rechazado por presupuesto');
  });

  await check('d2 (punto 4): clase A sin gasto — pasadas 5 rondas sigue con backoff largo (15 min…4 h); alerta a las 48 h; excepción recién a las 72 h; legacy conserva el tope', () => {
    const P = AH.DEFAULT_AUTO_HEAL_POLICY;
    const A = '❌ Falló después de 3 intentos: Error del servidor (503)';
    eq(AH.autoHealDecision(rowOf(A, 'content', { os: { autoHeal: { rounds: 5 } }, secAgo: 60 }), NOW, P).reason, 'backoff', 'ronda 6 espera');
    const r6 = AH.autoHealDecision(rowOf(A, 'content', { os: { autoHeal: { rounds: 5 } }, secAgo: 1200 }), NOW, P);
    eq([r6.heal, r6.round, r6.extended], [true, 6, true], 'ronda 6 extendida');
    const r30 = AH.autoHealDecision(rowOf(A, 'content', { os: { autoHeal: { rounds: 30, firstAt: new Date(NOW - 20 * 3600e3).toISOString() } }, secAgo: 5 * 3600 }), NOW, P);
    eq([r30.heal, r30.round, !!r30.alert], [true, 31, false], 'ronda 31 (sin tope de rondas)');
    const al = AH.autoHealDecision(rowOf(A, 'content', { os: { autoHeal: { rounds: 30, firstAt: new Date(NOW - 49 * 3600e3).toISOString() } }, secAgo: 5 * 3600 }), NOW, P);
    eq([al.heal, al.alert], [true, true], 'alerta');
    eq(AH.autoHealDecision(rowOf(A, 'content', { os: { autoHeal: { rounds: 30, firstAt: new Date(NOW - 73 * 3600e3).toISOString() } }, secAgo: 5 * 3600 }), NOW, P).reason, 'recovery_window_exhausted', 'excepción a las 72 h');
    eq(AH.autoHealDecision(rowOf(A, 'content', { os: { autoHeal: { rounds: 3 } }, secAgo: 3600 }), NOW, AH.LEGACY_AUTO_HEAL_POLICY).reason, 'cap_reached', 'legacy (kill-switch) sin cambios');
    // Un A con riesgo de pago incierto nunca entra (los inciertos tienen su propia regla).
    eq(AH.autoHealDecision(rowOf('prior_call_in_flight: x', 'audio_welcome', { os: { autoHeal: { rounds: 5 } }, secAgo: 3600 }), NOW, P).reason, 'not_allow_listed', 'incierto: no');
  });

  await check('K3: kill switch / allow-list de FinOps → D wait_provider (attention config) y currentRecovery spend_control_resume; nunca sobre un fallo con riesgo de pago', () => {
    const msgs = [
      ['finops_kill_switch: el interruptor de gasto del servidor (FINOPS_KILL_SWITCH) está activo: no se hacen llamadas pagadas nuevas (anthropic). No se hizo la llamada (sin gasto).', 'content', 'finops_kill_switch', 'anthropic'],
      ['unexpected_error: finops_ledger_write_failed: la reserva tts/chunk0 — el interruptor de gasto del servidor (FINOPS_KILL_SWITCH) está activo: no se hacen llamadas pagadas nuevas (openai)', 'audio_welcome', 'finops_kill_switch', 'openai'],
      ['provider_not_allowed: el proveedor gamma no está en FINOPS_PROVIDER_ALLOWLIST: no se llama. No se hizo la llamada (sin gasto).', 'presentation', 'provider_not_allowed', 'gamma'],
    ];
    const saved = process.env.DYNAMIC_COURSE_STRUCTURE;
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    try {
      for (const [m, type, code, provider] of msgs) {
        eq(SCH.spendControlHoldOf(m, type), { code, provider }, `hold ${type}`);
        const v = FC.classifyFailure({ error: m, itemType: type, source: type === 'content' ? 'browser_executor' : 'provider_worker' });
        eq([v.class, v.strategy, v.humanReason, v.scope], ['D', 'wait_provider', 'config', 'run'], `veredicto ${type}`);
        eq(FC.currentRecoveryOf(m, type, {}), 'spend_control_resume', `currentRecovery ${type}`);
      }
    } finally {
      if (saved === undefined) delete process.env.DYNAMIC_COURSE_STRUCTURE; else process.env.DYNAMIC_COURSE_STRUCTURE = saved;
    }
    eq(SCH.spendControlHoldOf('provider_reconciliation_required: openai — x (FINOPS_KILL_SWITCH)', 'audio_welcome'), null, 'con riesgo de pago: no');
    eq(SCH.spendControlHoldOf('unattributed_ceiling_reached: techo', 'content'), null, 'techo sin atribuir: no (no lo dispara una parte)');
  });

  await check('d8: claim_payload_unavailable — dependencia completada después del fallo → reabrir gratis; dato inutilizable → regenerar la dependencia UNA vez; ya regenerada / contrato → excepción', () => {
    const t0 = new Date('2026-10-19T10:00:00Z').toISOString();
    const t1 = new Date('2026-10-19T10:05:00Z').toISOString();
    const vi = (code, os = {}) => ({ type: 'video_interactions', chapter_id: 'ch1', error: `claim_payload_unavailable: ${code}: el video video:ch1 …`, output_summary: os, finished_at: t1 });
    eq(CPR.claimPayloadDependencyKey(vi('VIDEO_YOUTUBE_ID_MISSING')), 'video:ch1', 'dependencia');
    eq(CPR.claimPayloadRecoveryDecision(vi('VIDEO_NOT_COMPLETED'), { item_key: 'video:ch1', status: 'running', generation: 1, finished_at: null }).action, 'wait', 'dependencia en curso → espera');
    eq(CPR.claimPayloadRecoveryDecision(vi('VIDEO_NOT_COMPLETED'), { item_key: 'video:ch1', status: 'completed', generation: 1, finished_at: t0 }).action, 'reopen', 'completada → reabrir');
    eq(CPR.claimPayloadRecoveryDecision(vi('VIDEO_YOUTUBE_ID_MISSING'), { item_key: 'video:ch1', status: 'completed', generation: 1, finished_at: t0 }, 'mock').action, 'regenerate_dependency', 'dato inutilizable (video mock) → regenerar');
    eq(CPR.claimPayloadRecoveryDecision(vi('VIDEO_YOUTUBE_ID_MISSING'), { item_key: 'video:ch1', status: 'completed', generation: 1, finished_at: t0 }).reason, 'real_video_requires_review', 're-review m5: sin modo = real (falla cerrado)');
    const regen = { item_key: 'video:ch1', status: 'completed', generation: 2, finished_at: t0, output_summary: { regeneration: { reason: CPR.CLAIM_PAYLOAD_DEPENDENCY_REASON } } };
    eq(CPR.claimPayloadRecoveryDecision(vi('VIDEO_YOUTUBE_ID_MISSING'), regen), { action: 'exception', depKey: 'video:ch1', code: 'VIDEO_YOUTUBE_ID_MISSING', reason: 'already_regenerated' }, 'una sola vez');
    eq(CPR.claimPayloadRecoveryDecision(vi('VIDEO_YOUTUBE_ID_MISSING'), { ...regen, finished_at: new Date('2026-10-19T10:30:00Z').toISOString() }).action, 'reopen', 'regenerada y completada después → reabrir');
    eq(CPR.claimPayloadRecoveryDecision(vi('VIDEO_NOT_COMPLETED', { claimPayloadRecovery: { reopens: 3 } }), { item_key: 'video:ch1', status: 'completed', generation: 1, finished_at: t0 }).reason, 'reopen_cap', 'anti-bucle');
    eq(CPR.claimPayloadRecoveryDecision({ type: 'application_activity', chapter_id: 'ch1', error: 'claim_payload_unavailable: MISSING_APPLICATION_MINUTES: x', finished_at: t1 }, null).reason, 'contract', 'contrato → excepción');
    // Review I1: con video REAL nunca se repaga un render (excepción); PLAN_INVARIANT / DURATION_INVALID = product_bug.
    eq(CPR.claimPayloadRecoveryDecision(vi('VIDEO_YOUTUBE_ID_MISSING'), { item_key: 'video:ch1', status: 'completed', generation: 1, finished_at: t0 }, 'real').reason, 'real_video_requires_review', 'video real → excepción, sin regenerar');
    eq(CPR.claimPayloadRecoveryDecision(vi('VIDEO_NOT_COMPLETED'), { item_key: 'video:ch1', status: 'completed', generation: 1, finished_at: t0 }, 'real').action, 'reopen', 'video real: reabrir (gratis) sí');
    for (const c of ['VIDEO_PLAN_INVARIANT', 'VIDEO_DURATION_INVALID']) {
      eq(CPR.claimPayloadRecoveryDecision(vi(c), { item_key: 'video:ch1', status: 'completed', generation: 1, finished_at: t0 }).reason, 'contract', `${c} → product_bug`);
      eq(FC.classifyFailure({ error: vi(c).error, itemType: 'video_interactions', source: 'scheduler' }).humanReason, 'product_bug', `${c}: clasificador`);
    }
    const v = FC.classifyFailure({ error: vi('VIDEO_YOUTUBE_ID_MISSING').error, itemType: 'video_interactions', source: 'scheduler' });
    eq([v.class, v.strategy], ['B', 'regenerate_dependency'], 'clasificador');
  });

  await check('integración N1×N2: una sola vía por reserva — con id consultable (Videogen jobId / Gamma generationId) la concilia N2 con evidencia; sin id, la vía possible_duplicate', () => {
    const vg = 'reservation:videogen:ir:g1:a1:submit';
    const gm = 'reservation:gamma:ir:g1:a1:submit';
    eq(AR.reservationHasConsultableId(vg, { external: { videogenJobId: 'job_1' }, externalReservationKey: vg }), true, 'videogen con jobId → N2');
    eq(AR.reservationHasConsultableId(vg, { previousExternals: [{ external: { videogenJobId: 'job_1' }, externalReservationKey: vg }] }), true, 'archivado con jobId → N2');
    eq(AR.reservationHasConsultableId(vg, { externalSubmitStartedAt: 'x' }), false, 'videogen sin jobId → N1');
    eq(AR.reservationHasConsultableId(gm, { external: { gammaGenerationId: 'gen_1' }, externalReservationKey: gm }), true, 'gamma con generationId → N2');
    eq(AR.reservationHasConsultableId(gm, { external: {} }), false, 'gamma sin id → N1');
    eq(AR.reservationHasConsultableId('reservation:tts:ir:g1:a1:chunk0', { external: { gammaGenerationId: 'gen_1' } }), false, 'TTS → N1 siempre');
  });

  await check('M1: run que el servidor está recuperando solo (sin acciones humanas) → completion.autoRecovering; con una acción humana o sin el tick, no', () => {
    const saved = process.env.DYNAMIC_COURSE_STRUCTURE;
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    try {
      const now = new Date();
      const job = { id: 'j', status: 'failed', worker_status: 'failed', input_payload: {} };
      const m = { items: [{ key: 'content:x', type: 'content' }], rulesVersion: 2 };
      const row = (error) => [{ id: 'i1', item_key: 'content:x', type: 'content', status: 'failed', error, output_summary: {}, finished_at: now.toISOString() }];
      const a = RC.evaluateRunCompletion(job, row('❌ Falló después de 3 intentos: Error del servidor (503)'), m, null, { now });
      eq([a.state, a.autoRecovering, a.adminActions], ['needs_attention', true, []], 'A en espera → recuperándose solo');
      const k = RC.evaluateRunCompletion(job, row('finops_kill_switch: el interruptor de gasto del servidor (FINOPS_KILL_SWITCH) está activo (anthropic)'), m, null, { now });
      eq([k.autoRecovering, k.adminActions], [true, []], 'kill switch: sin retry_item, recuperándose solo');
      // re-review m5: un claim incompleto sin resolver pasado el techo → la acción de admin aparece igual.
      const cpRow = (minsAgo) => [{ id: 'i1', item_key: 'content:x', type: 'video_interactions', chapter_id: 'ch1', status: 'failed',
        error: 'claim_payload_unavailable: VIDEO_YOUTUBE_ID_MISSING: x', output_summary: {}, finished_at: new Date(now.getTime() - minsAgo * 60_000).toISOString() }];
      eq(RC.adminActionFor(cpRow(1)[0], 'not_done', now), null, 'claim incompleto reciente: el barrido lo resuelve');
      eq(RC.adminActionFor(cpRow(31)[0], 'not_done', now)?.code, 'retry_item', 'pasado el techo de 30 min: acción visible');
      // re-review m5-bis: con la dependencia (video) viva / en vuelo o fallida → sin retry_item aunque pasen horas.
      for (const st of ['pending', 'running', 'retrying', 'blocked', 'failed']) {
        eq(RC.adminActionFor(cpRow(180)[0], 'not_done', now, null, { dep: { item_key: 'video:ch1', type: 'video', status: st, finished_at: null } }), null, `dependencia ${st}: sin acción`);
      }
      // Dependencia completada hace poco: el techo se cuenta desde su fin (no desde el fallo de la parte).
      const depDone = (minsAgo) => ({ item_key: 'video:ch1', type: 'video', status: 'completed', finished_at: new Date(now.getTime() - minsAgo * 60_000).toISOString() });
      eq(RC.adminActionFor(cpRow(180)[0], 'not_done', now, null, { dep: depDone(5) }), null, 'dependencia recién completada: dentro del techo');
      eq(RC.adminActionFor(cpRow(180)[0], 'not_done', now, null, { dep: depDone(40) })?.code, 'retry_item', 'dependencia completada hace 40 min y sin resolver: acción visible');
      // re-review 3: dependencia cancelada / omitida → nunca oculta para siempre; con el techo desde el fin de la dependencia.
      for (const st of ['cancelled', 'skipped']) {
        const dd = (minsAgo) => ({ item_key: 'video:ch1', type: 'video', status: st, finished_at: new Date(now.getTime() - minsAgo * 60_000).toISOString() });
        // review lost_result: sin recuperación automática viva → acción INMEDIATA (sin esperar el techo).
        eq(RC.adminActionFor(cpRow(1)[0], 'not_done', now, null, { dep: dd(1) })?.code, 'retry_item', `${st}: acción inmediata`);
        eq(RC.adminActionFor({ ...cpRow(1)[0], attention_reason: 'dependency_unavailable' }, 'not_done', now)?.code, 'retry_item', `${st}: atención dependency_unavailable → acción inmediata`);
        eq(CPR.claimPayloadRecoveryDecision(cpRow(1)[0], dd(1), 'mock'), { action: 'exception', depKey: 'video:ch1', code: 'VIDEO_YOUTUBE_ID_MISSING', reason: 'dependency_unavailable' }, `${st}: el barrido la registra como excepción`);
      }
      const vjob = { id: 'j', status: 'failed', worker_status: 'failed', input_payload: {} };
      const vm = { items: [{ key: 'video:ch1', type: 'video' }, { key: 'content:x', type: 'video_interactions' }], rulesVersion: 2 };
      const ev = RC.evaluateRunCompletion(vjob, [...cpRow(180), { id: 'v1', item_key: 'video:ch1', type: 'video', status: 'running', output_summary: {}, finished_at: null }], vm, null, { now });
      assert(!(ev.adminActions || []).some((x) => x.itemKey === 'content:x'), `evaluateRunCompletion pasa la dependencia: ${JSON.stringify(ev.adminActions)}`);
      const d = RC.evaluateRunCompletion(job, row('contract_x: nope'), m, null, { now });
      eq([d.autoRecovering, d.adminActions.map((x) => x.code)], [undefined, ['retry_item']], 'falla para un humano: sin el flag');
      process.env.DYNAMIC_AUTO_HEAL_ENABLED = 'false';
      eq(RC.evaluateRunCompletion(job, row('❌ Falló después de 3 intentos: Error del servidor (503)'), m, null, { now }).autoRecovering, undefined, 'tick apagado: nadie lo recupera');
    } finally {
      delete process.env.DYNAMIC_AUTO_HEAL_ENABLED;
      if (saved === undefined) delete process.env.DYNAMIC_COURSE_STRUCTURE; else process.env.DYNAMIC_COURSE_STRUCTURE = saved;
    }
  });

  await llmChecks();
}

// ─── c4: worker de IA con un Anthropic falso y un ledger en memoria ─────────
async function fakeAnthropic(plan) {
  const st = { requests: 0 };
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req) { /* body */ }
    const n = ++st.requests;
    const p = plan(n);
    if (p === 'drop') { req.socket.destroy(); return; }
    const sse = (ev, d) => `event: ${ev}\ndata: ${JSON.stringify({ type: ev, ...d })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { message: { id: `msg_${n}`, model: 'm', usage: { input_tokens: 10, output_tokens: 1 } } }));
    res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `R${n}` } }));
    res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }));
    res.end(sse('message_stop', {}));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, st, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) };
}
const like = (pat) => new RegExp('^' + pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
function llmWorld(budgetFits, o = {}) {
  const w = { res: new Map(), cps: {}, sent: {}, store: new Map(), budgetCalls: [], released: [] };
  // r62 (I2-ter): reloj de la DB desfasado respecto del worker (created_at y now() salen de la DB).
  // Monótono estricto (como now() de una DB con resolución de µs): dos lecturas nunca empatan en el mismo ms.
  let lastDb = 0;
  const dbClock = () => { lastDb = Math.max(lastDb + 1, Date.now() + (o.dbSkewMs || 0)); return lastDb; };
  const unknown = (v) => !v.settled || v.possibleDuplicate;
  w.ds = {
    async query(sql, params) {
      if (sql.includes('as remaining_ms')) return [{ remaining_ms: 0 }];
      if (sql.includes('select now() as db_now')) return [{ db_now: new Date(dbClock()).toISOString() }];
      if (sql.includes('count(*)::int as n')) {
        const [keyLike, tagLike, , exclude] = params;
        return [{ n: [...w.res.entries()].filter(([k, v]) => like(keyLike).test(k) && like(tagLike).test(v.tag) && unknown(v) && !exclude.includes(k)).length }];
      }
      if (sql.includes('e.idempotency_key as key, e.amount::text as amount')) {
        const [keyLike, tagLike, , exclude, includePd] = params;
        return [...w.res.entries()].filter(([k, v]) => like(keyLike).test(k) && like(tagLike).test(v.tag) && (!v.settled || (includePd && v.possibleDuplicate)) && !exclude.includes(k))
          .map(([k, v]) => ({ key: k, amount: String(v.amount), settled: !!v.settled, send_marked: !!v.sendMarked, created_at: new Date(v.at || Date.now() - 3600e3).toISOString() }));
      }
      if (sql.includes("'{llmSent}'")) { w.sent[params[2]] = params[3]; return [{ id: params[0] }]; }
      if (sql.includes('generation_item_runs')) return [{ since: new Date(0).toISOString(), cps: { ...w.cps }, sent: { ...w.sent } }];
      throw new Error('SQL inesperado: ' + sql.slice(0, 80));
    },
  };
  w.finops = {
    async recordCharge(i) { w.res.set(i.idempotencyKey, { tag: i.metadata.callTag, settled: false, amount: 0.05, sendMarked: !!i.metadata.sendMarked, at: dbClock() }); return {}; },
    async recordAdjustment() { return {}; }, async recordZero() { return {}; },
    async settleReservation(key, charge, reason) { const r = w.res.get(key); r.settled = true; r.reason = reason; r.charged = !!charge; if (!charge) w.released.push({ key, reason }); return { finalInserted: !!charge, finalEvent: null }; },
    ...(o.noReconcile ? {} : {
      async reconcileReservationAsCharged(key, reason, opt) {
        const r = w.res.get(key);
        if (r.settled) return { reconciled: false, alreadySettled: true, amount: String(r.amount), event: null };
        Object.assign(r, { settled: true, possibleDuplicate: opt.metadata.possibleDuplicate === true, decidedBy: opt.decidedBy, reason });
        return { reconciled: true, alreadySettled: false, amount: String(r.amount), event: null };
      },
    }),
  };
  w.budget = {
    guardServerLlmCall: async () => null,
    ...(o.noBudget ? {} : { ambiguousResendBudget: async (a) => { w.budgetCalls.push(a); return { fits: budgetFits, reason: budgetFits ? null : 'item_recovery_budget', worstItem: 0.6, worstRun: 3 }; } }),
  };
  w.api = (url, attempt = 1, extra = {}) => SL.createServerApi({
    dataSource: w.ds, finops: w.finops, budget: w.budget,
    checkpoints: { put: async (p, j) => { w.store.set(p, j); }, get: async (p) => (w.store.has(p) ? w.store.get(p) : null) },
    recordCheckpoint: async (_id, e) => { Object.assign(w.cps, e); return true; },
    apiKey: 'k', baseUrl: url, defaultModel: 'm', idleMs: 2000, totalMs: 5000,
    logger: { log() {}, warn() {}, error() {} }, settleRetryDelaysMs: [0], ...extra,
  }, { itemRunId: '11111111-2222-4333-8444-555555555555', runId: 'run-1', itemKey: 'content:x', generation: 1, ownerId: 'o', artifactCourseId: '7', manifestId: 3, attempt }, () => ({ callRole: 'main', attempt }));
  /** Reserva HUÉRFANA de un intento caído para la llamada `prompt` (mismo hash que la reenviaría el carril). */
  w.orphan = (prompt, attempt, opts = {}) => {
    const body = SL.serverLlmRequestBody({ system: 's', user: prompt, defaultModel: 'm' }).body;
    const hash = SL.serverLlmRequestHash(body);
    const key = `reservation:llm:11111111-2222-4333-8444-555555555555:g1:a${attempt}:llmw-main-${hash.slice(0, 12)}-1-dead${prompt}`;
    w.res.set(key, { tag: `llmw-main-${hash.slice(0, 12)}-1-dead${prompt}`, settled: false, amount: 0.05, sendMarked: !!opts.sendMarked });
    if (opts.marked) w.sent[key] = new Date(Date.now() - 3600e3).toISOString();
    return key;
  };
  return w;
}
async function err(p) { try { return { v: await p }; } catch (e) { return { e }; } }
const markSentDep = (w) => ({ markSent: async (id, key, at) => { w.sent[key] = at; return true; } });

async function llmChecks() {
  await check('c4 (punto 3, Anthropic): resultado desconocido → peor caso dentro de lo autorizado → la reserva perdida se liquida como cobrada (possible_duplicate, system) y se reenvía UNA vez', async () => {
    const a = await fakeAnthropic((n) => (n === 1 ? 'drop' : 'ok'));
    const w = llmWorld(true);
    const r = await err(w.api(a.url)('s', 'P'));
    eq([r.v, a.st.requests, w.budgetCalls.length], ['R2', 2, 1], 'un reenvío');
    const vals = [...w.res.values()];
    eq(vals.map((x) => [x.possibleDuplicate === true, x.decidedBy || null, !!x.charged]), [[true, 'system', false], [false, null, true]], 'perdida → posible duplicado; el reenvío medido');
    eq(w.budgetCalls[0].authorization, 'any', 'autorización de IA');
    await a.close();
  });
  await check('c4: el peor caso NO entra → sin reenvío: la parte queda en revisión (llm_pending_review, humanReason budget) con la reserva intacta para conciliar', async () => {
    const a = await fakeAnthropic((n) => (n === 1 ? 'drop' : 'ok'));
    const w = llmWorld(false);
    const r = await err(w.api(a.url)('s', 'P'));
    assert(r.e && r.e.pendingReview && /no entra en el presupuesto autorizado/.test(r.e.msg), `revisión: ${JSON.stringify(r.e)}`);
    eq([a.st.requests, [...w.res.values()].filter((x) => !x.settled).length], [1, 1], '0 reenvíos, reserva pendiente');
    eq(FC.classifyFailure({ error: r.e.msg, source: 'server_executor' }).humanReason, 'budget', 'excepción de presupuesto');
    await a.close();
  });
  await check('c4: a lo sumo UN reenvío por llamada — el reenvío vuelve a ser desconocido → revisión (sin un 3.er pedido)', async () => {
    const a = await fakeAnthropic(() => 'drop');
    const w = llmWorld(true);
    const r = await err(w.api(a.url)('s', 'P'));
    assert(r.e && r.e.pendingReview, 'revisión');
    eq(a.st.requests, 2, 'original + UN reenvío');
    eq(FC.classifyFailure({ error: r.e.msg, source: 'server_executor' }).humanReason, 'duplicate_charge', 'excepción de cobro duplicado');
    await a.close();
  });
  await check('I2: un worker caído con 3 llamadas en vuelo = UN evento → si la SUMA de las 3 reservas perdidas entra en el presupuesto, se liquidan las 3 como posible duplicado y cada carril reenvía la suya una vez (sin revisión)', async () => {
    const a = await fakeAnthropic(() => 'ok');
    const w = llmWorld(true);
    const lost = ['L1', 'L2', 'L3'].map((p) => w.orphan(p, 1));
    const api = w.api(a.url, 2);
    const out = await Promise.all(['L1', 'L2', 'L3'].map((p) => err(api('s', p))));
    assert(out.every((x) => x.v && !x.e), 'ningún carril a revisión: ' + JSON.stringify(out.map((x) => x.e)));
    eq(a.st.requests, 3, 'un pedido por carril');
    assert(lost.every((k) => w.res.get(k).possibleDuplicate === true), 'las 3 perdidas = posible duplicado');
    assert(Math.abs(w.budgetCalls[0].nextCost - 0.15) < 1e-9, `nextCost = suma de las 3 (${w.budgetCalls[0].nextCost})`);
    // Un SEGUNDO evento (desconocido de otro intento) → revisión.
    w.orphan('L9', 3);
    const r2 = await err(api('s', 'L9'));
    assert(r2.e && r2.e.pendingReview && /eventos ambiguos/.test(r2.e.msg), `segundo evento → revisión: ${JSON.stringify(r2.e)}`);
    await a.close();
  });
  await check('I2-bis: evento = intento anterior O solapamiento — A desconocida → reenvío; B desconocida DESPUÉS en el mismo intento → revisión; respaldo max(4, carriles)', async () => {
    const t = (ms) => new Date(Date.UTC(2026, 9, 20, 12, 0, 0) + ms);
    eq(SL.countUnknownEvents([{ attempt: 1, createdAt: t(0) }, { attempt: 1, createdAt: t(5) }], 2, null), 1, 'un intento caído = 1 evento');
    eq(SL.countUnknownEvents([{ attempt: 2, createdAt: t(0) }, { attempt: 2, createdAt: t(5) }], 2, t(10)), 1, 'solapadas en el intento actual = 1 evento');
    eq(SL.countUnknownEvents([{ attempt: 2, createdAt: t(0) }, { attempt: 2, createdAt: t(20) }], 2, t(10)), 2, 'una nueva después de detectar la primera = 2.º evento');
    eq(SL.countUnknownEvents([{ attempt: 1, createdAt: t(0) }, { attempt: 2, createdAt: t(20) }], 2, t(10)), 2, 'caído + nueva = 2 eventos');
    eq([SL.llmUnknownItemMax(), SL.llmUnknownItemMax(6)], [4, 6], 'respaldo max(4, carriles)');
    const a = await fakeAnthropic((n) => (n === 1 || n === 3 ? 'drop' : 'ok'));
    const w = llmWorld(true);
    const api = w.api(a.url);
    eq((await err(api('s', 'A'))).v, 'R2', 'A: un reenvío');
    const rb = await err(api('s', 'B'));
    assert(rb.e && rb.e.pendingReview && /eventos ambiguos/.test(rb.e.msg), `B → revisión: ${JSON.stringify(rb.e)}`);
    eq(a.st.requests, 3, 'B no se reenvía');
    await a.close();
  });
  await check('re-review I2-ter: el solapamiento usa el reloj de la DB — con el worker atrasado o adelantado 5 s respecto de la DB, A desconocida → reenvío y B desconocida después → revisión igual', async () => {
    for (const dbSkewMs of [5000, -5000]) {
      const a = await fakeAnthropic((n) => (n === 1 || n === 3 ? 'drop' : 'ok'));
      const w = llmWorld(true, { dbSkewMs });
      const api = w.api(a.url);
      eq((await err(api('s', 'A'))).v, 'R2', `skew ${dbSkewMs}: A un reenvío`);
      await new Promise((r) => setTimeout(r, 3)); // B nace DESPUÉS (en producción, tras el viaje de red del reenvío de A)
      const rb = await err(api('s', 'B'));
      assert(rb.e && rb.e.pendingReview && /eventos ambiguos/.test(rb.e.msg), `skew ${dbSkewMs}: B → revisión: ${JSON.stringify(rb.e)}`);
      eq(a.st.requests, 3, `skew ${dbSkewMs}: B no se reenvía`);
      await a.close();
    }
    // Y dos llamadas solapadas siguen siendo UN evento con el reloj desfasado.
    for (const dbSkewMs of [5000, -5000]) {
      const a = await fakeAnthropic((n) => (n <= 2 ? 'drop' : 'ok'));
      const w = llmWorld(true, { dbSkewMs });
      const api = w.api(a.url);
      const out = await Promise.all(['P1', 'P2'].map((p) => err(api('s', p))));
      assert(out.every((x) => x.v && !x.e), `skew ${dbSkewMs}: solapadas sin revisión: ${JSON.stringify(out.map((x) => x.e))}`);
      await a.close();
    }
  });
  await check('re-review m3: markSent lanza (DB) → la reserva se LIBERA (never_sent), no se envía nada y no queda abierta', async () => {
    const a = await fakeAnthropic(() => 'ok');
    const w = llmWorld(true);
    const r = await err(w.api(a.url, 1, { markSent: async () => { throw new Error('db caída'); } })('s', 'M'));
    assert(r.e && r.e.fatal === false && /no se pudo registrar el envío/.test(r.e.msg), JSON.stringify(r.e));
    eq([a.st.requests, [...w.res.values()].filter((x) => !x.settled).length, w.released.map((x) => x.reason)], [0, 0, ['llm_worker_never_sent']], '0 pedidos, 0 abiertas');
    await a.close();
  });
  await check('I3: falla cerrado — sin ambiguousResendBudget o sin reconcileReservationAsCharged nunca se reenvía (revisión, humanReason budget)', async () => {
    for (const o of [{ noBudget: true }, { noReconcile: true }]) {
      const a = await fakeAnthropic((n) => (n === 1 ? 'drop' : 'ok'));
      const w = llmWorld(true, o);
      const r = await err(w.api(a.url)('s', 'P'));
      assert(r.e && r.e.pendingReview && /falla cerrado/.test(r.e.msg), `${JSON.stringify(o)}: ${JSON.stringify(r.e)}`);
      eq(a.st.requests, 1, `${JSON.stringify(o)}: 0 reenvíos`);
      eq(FC.classifyFailure({ error: r.e.msg, source: 'server_executor' }).humanReason, 'budget', 'humanReason');
      await a.close();
    }
  });
  await check('E2E-M: kill -9 entre la reserva y el envío → la reserva (marcada, sin marca de envío) se LIBERA sola; kill después del envío → se liquida cobrada (possible_duplicate) y nunca queda abierta con la parte completa', async () => {
    const a = await fakeAnthropic(() => 'ok');
    const w = llmWorld(true);
    const neverSent = w.orphan('K', 1, { sendMarked: true });
    const api = w.api(a.url, 2, markSentDep(w));
    const r = await err(api('s', 'K'));
    eq([r.v, a.st.requests], ['R1', 1], 'completa con UN pedido');
    eq([w.res.get(neverSent).possibleDuplicate === true, w.released.find((x) => x.key === neverSent)?.reason], [false, 'llm_worker_never_sent_orphan'], 'nunca enviada → liberada (sin gasto)');
    eq(w.budgetCalls.length, 0, 'no es un reenvío ambiguo');
    // La propia reserva del envío lleva la marca durable (sendMarked + llmSent).
    const own = [...w.res.entries()].find(([k]) => k.includes(':a2:'));
    assert(own[1].sendMarked && w.sent[own[0]], 'marca durable de envío');
    // Enviada (con marca) y nunca respondida, de una llamada que no se vuelve a pedir: settleLeftovers la deja cobrada.
    const w2 = llmWorld(true);
    const sent = w2.orphan('Z', 1, { sendMarked: true, marked: true });
    const api2 = w2.api(a.url, 2, markSentDep(w2));
    await api2('s', 'otra');
    const lo = await api2.settleLeftovers();
    eq([lo.released, lo.settled, w2.res.get(sent).possibleDuplicate === true], [0, 1, true], 'enviada → cobrada (posible duplicado), nunca abierta');
    eq([...w2.res.values()].filter((x) => !x.settled).length, 0, '0 reservas abiertas al completar');
    await a.close();
  });
}

// ════════════════════════════════════════════════════════════════════════════
function findPgBin() {
  for (const d of [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
    const pg = path.join(d, 'postgres');
    if (fs.existsSync(pg) && /\b16\./.test(spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '')) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => ([5570, 8099].includes(port) ? freePort().then(resolve, reject) : resolve(port))); });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}
const OWNER = '11111111-2222-4333-8444-555555555555';
const CONTEXT = { nombre: 'Curso r62', sector: 'Minería', pais: 'Chile', contexto: 'Planta', nivel: 'Intermedio', tono: 'cercano' };
const PROVIDER_ENV_KEYS = ['GAMMA_API_KEY', 'GAMMA_THEME_V21_LIGHT_DEFAULT', 'GAMMA_THEME_V21_DARK_DEFAULT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VIDEOGEN_API_KEY'];
const ENV_KEYS = [
  'DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION', 'DYNAMIC_VIDEO_DELIVERY',
  'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_PROVIDER_WORKER_ENABLED', 'DYNAMIC_ALLOW_PROVIDER_MOCK', 'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY', 'GAMMA_API_BASE_URL', 'OPENAI_API_BASE_URL', 'ANTHROPIC_API_BASE_URL', 'DYNAMIC_ALLOW_VIDEO_PREVIEW', 'SUPER_ADMIN_EMAILS',
  'FINOPS_KILL_SWITCH', 'FINOPS_PROVIDER_ALLOWLIST', ...PROVIDER_ENV_KEYS,
];
const READY_ENV = () => ({
  GAMMA_API_KEY: SECRETS.GAMMA_API_KEY, GAMMA_THEME_V21_LIGHT_DEFAULT: 'theme-r62-light', GAMMA_THEME_V21_DARK_DEFAULT: 'theme-r62-dark',
  OPENAI_API_KEY: SECRETS.OPENAI_API_KEY, ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY, VIDEOGEN_API_KEY: SECRETS.VIDEOGEN_API_KEY,
});

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
  const { ArtifactsService } = loadDist('modules/artifacts/artifacts.service.js');
  const { Artifact } = loadDist('modules/artifacts/entities/artifact.entity.js');
  const T = loadDist('modules/dynamic-generation/item-transitions.js');
  const ATT = loadDist('modules/reliability/attempt-log.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r62-n1-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r62-n1-cwd-'));
  const ROLE = 'postgres.r62localtest01';
  const DB = 'r62db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let ds = null;
  const storage = startStorage();
  const fakes = startProviderFakes({ gammaKey: SECRETS.GAMMA_API_KEY, openaiKey: SECRETS.OPENAI_API_KEY, anthropicKey: SECRETS.ANTHROPIC_API_KEY, makePdf: SM.syntheticPdf, makeMp3: SM.syntheticMp3 });
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`\nPostgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', async (c) => { await c.query(`create database ${DB}`); await c.query(`create role "${ROLE}" superuser login`); });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    { const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({})); assert(res.code === 0, `constraints: ${res.out}`); }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/verify-v21-finops-schema.js', 'scripts/migrate-rel-recovery.js']) {
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }
    await new Promise((res) => storage.srv.listen(0, '127.0.0.1', res));
    const storageUrl = `http://127.0.0.1:${storage.srv.address().port}`;
    const urls = await fakes.listen();
    for (const u of [storageUrl, urls.gammaUrl, urls.openaiUrl, urls.anthropicUrl]) assert(/^http:\/\/127\.0\.0\.1:\d+/.test(u), `fake fuera de loopback: ${u}`);

    Object.assign(process.env, {
      DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_REAL_VIDEO_OWNERS: OWNER, DYNAMIC_MANIFEST_RULES_VERSION: '3', DYNAMIC_VIDEO_DELIVERY: 'youtube',
      DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true', SUPER_ADMIN_EMAILS: 'admin@cursia.test',
      SUPABASE_URL: storageUrl, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-local-only',
      GAMMA_API_BASE_URL: urls.gammaUrl, OPENAI_API_BASE_URL: urls.openaiUrl, ANTHROPIC_API_BASE_URL: urls.anthropicUrl, ...READY_ENV(),
    });
    for (const k of ['DYNAMIC_V2_ALLOWED_OWNERS', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'DYNAMIC_ALLOW_PROVIDER_MOCK', 'FINOPS_KILL_SWITCH', 'FINOPS_PROVIDER_ALLOWLIST']) delete process.env[k];

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Artifact], synchronize: false });
    await ds.initialize();
    ATT.resetRelSchemaCache();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const runs = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const sched = new SchedulerService(ds, runs);
    const artifacts = new ArtifactsService(ds.getRepository(Artifact), { get: (k) => process.env[k] });

    async function makeCourse(title, { videos = false } = {}) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID(); const c1 = crypto.randomUUID(); const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'Bombas', objective: null, video_enabled: videos, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'Válvulas', objective: null, video_enabled: false, activity_enabled: false }],
      );
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) {
          await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`,
            [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
        }
      }
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      await manifests.getOrCreate(cid, OWNER, 1);
      return { cid, c1, c2, m1 };
    }
    const itemRow = async (runId, key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [runId, key]))[0];
    const events = (where, p) => ds.query(`select *, amount::text as amount from public.generation_cost_events where ${where} order by created_at, id`, p);
    const reservationsOf = async (itemRunId, provider) => {
      const rows = await events(`item_run_id = $1 and provider = $2 and event_kind = 'CHARGE' and metadata->>'reservation' = 'true'`, [itemRunId, provider]);
      for (const x of rows) x.adj = (await events(`corrects_event_id = $1`, [x.id]))[0] || null;
      return rows;
    };
    const attempts = (id) => ds.query(`select * from public.generation_item_attempts where item_run_id = $1 order by created_at, id`, [id]);
    async function seedDependency(runId, key, type, body, mime) {
      const row = await itemRow(runId, key);
      const p = `${OWNER}/dynamic/r62/${runId}/${key.replace(/[^A-Za-z0-9._-]/g, '_')}.${type}`;
      storage.blobs.set(`cursia-artifacts/${p}`, Buffer.from(body));
      await ds.query(
        `insert into public.artifacts (owner_id, course_id, job_id, type, storage_provider, storage_bucket, storage_path, filename, mime_type, metadata, module_id, chapter_id, manifest_id, manifest_item_key, item_run_id)
         values ($1, $2, $3, $4, 'supabase', 'cursia-artifacts', $5, 'f', $6, '{}'::jsonb, $7, $8, $9, $10, $11)`,
        [OWNER, String(row.course_id), runId, type, p, mime, row.module_id, row.chapter_id, row.manifest_id, key, row.id]);
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where id = $1`, [row.id]);
    }
    const CONTENT_MD = (t) => `# ${t}\n\nLa bomba de engranajes mueve el aceite a presión constante. El técnico revisa ruido, temperatura y caudal en cada turno.\n\n## Mantenimiento\n\nSe cambia el filtro y se registra la presión.`;
    const SEC = (t, n) => `## ${t}\n\n` + Array.from({ length: n }, (_, i) => `El técnico revisa la bomba número ${i} y registra presión, caudal y temperatura en la planilla del turno.`).join(' ');
    /** Capítulo de 3 bloques (≥ 3 segmentos de TTS): el reenvío tiene que tocar SOLO el segmento afectado. */
    const LONG_MD = `# Bombas\n\n${SEC('Inspección', 34)}\n\n${SEC('Mantenimiento', 41)}\n\n${SEC('Registro', 49)}`;
    async function freshRun(title, { videos = false, authorized = '500', c1Md = null, welcome = null } = {}) {
      const K = await makeCourse(title, { videos });
      const e = await rejectsRe(runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' }), /^budget_approval_required/, `aprobación ${title}`, 409);
      await budget.adminAuthorize({ courseId: K.cid, estimateId: e.getResponse().estimateId, authorizedBudget: authorized, approvedBy: 'admin@cursia.test' });
      const rid = (await runs.startRun(K.cid, OWNER, 1, { ...CONTEXT, videoMode: 'mock' })).run.id;
      await seedDependency(rid, `content:${K.c1}`, 'dynamic_content_md', c1Md || CONTENT_MD('Bombas'), 'text/markdown');
      await seedDependency(rid, `content:${K.c2}`, 'dynamic_content_md', CONTENT_MD('Válvulas'), 'text/markdown');
      await seedDependency(rid, `course_intro:${K.cid}`, 'dynamic_course_intro_json', JSON.stringify({ welcome: welcome || 'Hola y bienvenida al curso de hidráulica de planta.' }), 'application/json');
      return { ...K, rid };
    }
    const workerDeps = (over = {}) => ({
      scheduler: sched, dataSource: ds, artifacts, logger: capLogger, executorId: 'r62-provider-worker', leaseSeconds: 120,
      finops: ledger, budget, gammaPollMs: 20, gammaTimeoutMs: 3000,
      // Rasterizador falso: el check no depende de que el runner tenga pdftoppm (poppler-utils), como en CI.
      rasterizer: { async available() { return true; }, async firstPagePng() { return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'); } },
      ...over,
    });
    const claimProvider = (runId, type) => sched.claimNextItem({ executorId: 'r62-provider-worker', types: [type], leaseSeconds: 120, runId });
    const later = (mins) => new Date(Date.now() + mins * 60_000);
    const FAST = { ...process.env, PROVIDER_CALL_TIMEOUT_MS: '400', OPENAI_TTS_TIMEOUT_MS: '400' };
    const resubOf = (res, rid) => res.resubmitted.filter((x) => x.runId === rid);
    const runSpent = async (rid) => Number((await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where run_id = $1`, [rid]))[0].t);
    const paidAuthorized = async (rid) => Number(await budget.runPaidAuthorizedBudget(rid));

    // ═══ K1 — reproducción de #1510 ═══════════════════════════════════════════
    await check('K1 #1510: el TTS de un segmento del audiolibro VENCE (timeout del cliente) → el barrido lo resuelve solo: reserva perdida = charged + possible_duplicate (system), UN reenvío SOLO de ese segmento, completa; ledger ≤ autorizado; sin acción de admin', async () => {
      const R = await freshRun('r62 #1510', { c1Md: LONG_MD });
      const key = `audiobook_chapter:${R.c1}`;
      const tts0 = fakes.st.tts.length;
      const llm0 = fakes.st.llm.length;
      // Primer segmento OK, el segundo se cuelga y el cliente corta por timeout (el pedido llegó entero a OpenAI).
      fakes.plan.ttsFail = [undefined, 'hang'];
      const item = await claimProvider(R.rid, 'audiobook_chapter');
      assert(item && item.itemKey === key, `claim ${item && item.itemKey}`);
      const thrown = await PW.processProviderItem(workerDeps({ env: FAST }), item).then(() => null, (e) => e);
      fakes.plan.ttsFail = [];
      let row = await itemRow(R.rid, key);
      assert(thrown && /^provider_reconciliation_required: openai/.test(thrown.message), `timeout → reconciliación (${row.status}: ${row.error}; tts ${JSON.stringify(fakes.st.tts.slice(tts0))})`);
      eq(row.status, 'failed', 'failed');
      assert(/error de red \(TimeoutError\)/.test(row.error), `timeout del cliente: ${row.error}`);
      eq(fakes.st.tts.length - tts0, 2, 'dos llamadas TTS (una OK, una vencida)');
      const llmFirst = fakes.st.llm.length - llm0;
      const pend = (await reservationsOf(row.id, 'openai')).filter((x) => !x.adj);
      eq(pend.length, 1, 'una reserva pendiente (la del segmento vencido)');
      // K6: mientras el servidor lo va a resolver solo, no es un humano: sin attention_reason ni acción de admin.
      eq([row.failure_class, row.recovery_strategy, row.attention_reason], ['C', 'auto_resubmit_once', null], 'veredicto registrado');
      eq(RC.adminActionFor(row, 'not_done', new Date()), null, 'sin acción de admin');
      // Dentro de la espera: nada.
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: new Date() }), R.rid).length, 0, 'en espera');
      const res = await runs.autoResubmitAmbiguousAudio({ now: later(3) });
      eq(resubOf(res, R.rid).map((x) => x.itemKey), [key], 'UN reenvío automático');
      row = await itemRow(R.rid, key);
      const a = row.output_summary.ambiguousAudioResubmit;
      eq([row.status, a.rounds, a.cause, a.budget && a.budget.fits, a.possibleDuplicateKeys], ['pending', 1, 'timeout_presumed_charged', true, [pend[0].idempotency_key]], 'reapertura registrada');
      assert(a.budget.worstRun <= await paidAuthorized(R.rid) && a.budget.worstItem <= a.budget.itemHardLimit, `peor caso dentro de lo autorizado ${JSON.stringify(a.budget)}`);
      const [adj] = await events(`corrects_event_id = $1`, [pend[0].id]);
      eq([adj.metadata.possibleDuplicate, adj.metadata.decidedBy, adj.metadata.settlement, adj.metadata.cause, Number(adj.amount)],
        [true, 'system', 'reconciled_as_charged', 'timeout_presumed_charged', 0], 'reserva perdida = cobrada (posible duplicado), sigue contada');
      const last = (await attempts(row.id)).pop();
      eq([last.outcome, last.actor, last.strategy_applied], ['reopened', 'system', 'ambiguous_audio_resubmit:timeout_presumed_charged'], 'log de intentos: system + motivo');
      // El worker reenvía SOLO el segmento afectado (el primero ya estaba guardado) y completa.
      const t1 = fakes.st.tts.length;
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audiobook_chapter'));
      row = await itemRow(R.rid, key);
      eq(row.status, 'completed', `completa (${row.error})`);
      eq([fakes.st.tts.length - t1, row.output_summary.reusedSegments, fakes.st.llm.length - llm0], [row.output_summary.chunks - 1, 1, llmFirst], 'solo lo que faltaba; 0 LLM nuevas');
      eq(fakes.st.tts.length - tts0, row.output_summary.chunks + 1, 'a lo sumo 1 llamada de más en total (el reenvío único)');
      assert(await runSpent(R.rid) <= await paidAuthorized(R.rid), 'ledger ≤ autorizado');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(10) }), R.rid).length, 0, 'nada más que reenviar');
      // El audio quedó entregado: ya no falta en el run ni pide ninguna acción de admin (el resto del curso es otra parte).
      const dto = await runs.getRun(R.cid, OWNER, 1, R.rid);
      assert(!dto.completion.missingComponents.includes(key) && !(dto.completion.adminActions || []).some((x) => x.itemKey === key), `completion ${JSON.stringify(dto.completion).slice(0, 400)}`);
    });

    await check('K1: el reenvío único vuelve a vencer → nunca un segundo reenvío: excepción (c) registrada (attention_reason duplicate_charge, reconcile_provider); total = 1 reenvío', async () => {
      const R = await freshRun('r62 doble timeout');
      const key = `audio_welcome:${R.cid}`;
      fakes.plan.ttsFail = ['hang'];
      await rejectsRe(PW.processProviderItem(workerDeps({ env: FAST }), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required: openai/, '1.er timeout');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(3) }), R.rid).length, 1, 'reenvío único');
      const t0 = fakes.st.tts.length;
      fakes.plan.ttsFail = ['hang'];
      await rejectsRe(PW.processProviderItem(workerDeps({ env: FAST }), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required: openai/, '2.º timeout');
      fakes.plan.ttsFail = [];
      for (const m of [3, 60, 600]) {
        eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(m) }), R.rid).length, 0, `sin 2.º reenvío (+${m} min)`);
        eq((await runs.autoHealFailedItems({ now: later(m) })).reopened.filter((x) => x.runId === R.rid).length, 0, `auto-healer +${m} min`);
      }
      const row = await itemRow(R.rid, key);
      eq([row.status, row.attention_reason, row.recovery_strategy], ['failed', 'duplicate_charge', 'hold_for_human'], 'excepción registrada');
      eq(RC.adminActionFor(row, 'not_done', later(30)), { code: 'reconcile_provider', itemKey: key }, 'acción de admin');
      eq(fakes.st.tts.length - t0, 1, 'una sola llamada del reenvío');
      assert(await runSpent(R.rid) <= await paidAuthorized(R.rid), 'ledger ≤ autorizado');
    });

    await check('d10: el peor caso NO entra en el saldo autorizado → sin reenvío: excepción de presupuesto (declined over_budget:run_budget, attention_reason budget), 0 llamadas', async () => {
      const R = await freshRun('r62 sin saldo');
      fakes.plan.ttsFail = ['hang'];
      await rejectsRe(PW.processProviderItem(workerDeps({ env: FAST }), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required: openai/, 'timeout');
      fakes.plan.ttsFail = [];
      // El usuario autorizó justo lo ya gastado (con la reserva perdida): el reenvío lo superaría.
      const [est] = await ds.query(`select id from public.cost_estimates where run_id = $1 and scope = 'run' order by created_at desc limit 1`, [R.rid]);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, estimate_id, authorized_budget, decision, approved_by, reason) values ($1, $2, $3, $4, 'ADMIN_APPROVED', 'admin@cursia.test', 'r62: saldo justo')`,
        [R.rid, R.cid, est.id, String(await runSpent(R.rid))]);
      const t0 = fakes.st.tts.length;
      const res = await runs.autoResubmitAmbiguousAudio({ now: later(3) });
      eq([resubOf(res, R.rid).length, res.skipped.filter((x) => x.runId === R.rid).map((x) => x.reason)], [0, ['over_budget:run_budget']], 'no se reenvía');
      const row = await itemRow(R.rid, `audio_welcome:${R.cid}`);
      eq([row.status, row.output_summary.ambiguousAudioResubmit.declined, row.attention_reason], ['failed', 'over_budget:run_budget', 'budget'], 'excepción de presupuesto');
      eq(fakes.st.tts.length - t0, 0, '0 llamadas');
      eq((await reservationsOf(row.id, 'openai')).filter((x) => !x.adj).length, 1, 'la reserva queda pendiente para un admin');
    });

    // ═══ K2 + C1 — 5xx con cuerpo ════════════════════════════════════════════
    await check('C1: TTS «HTTP 504: upstream request timeout» → AMBIGUO: reserva conservada, reconciliación y el reenvío ÚNICO de K1 (possible_duplicate); completa y no queda ninguna reserva abierta', async () => {
      const R = await freshRun('r62 504');
      const key = `audio_welcome:${R.cid}`;
      fakes.plan.ttsFail = [{ status: 504, message: 'upstream request timeout' }];
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required: openai/, '504 → reconciliación');
      let row = await itemRow(R.rid, key);
      assert(/HTTP 504: .*upstream request timeout/.test(row.error), row.error);
      eq((await reservationsOf(row.id, 'openai')).filter((x) => !x.adj).length, 1, 'la reserva queda (posible cobro)');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(3) }), R.rid).length, 1, 'reenvío único automático');
      const t0 = fakes.st.tts.length;
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome'));
      row = await itemRow(R.rid, key);
      eq([row.status, fakes.st.tts.length - t0], ['completed', 1], `completa con UNA llamada (${row.error})`);
      const resv = await reservationsOf(row.id, 'openai');
      assert(resv.every((x) => x.adj), 'ninguna reserva abierta con la parte completada');
      assert(resv.some((x) => x.adj && x.adj.metadata.possibleDuplicate === true), 'la del 504 = cobrada (posible duplicado)');
    });

    await check('K2: TTS 503 (rechazo de admisión) → resultado conocido: reserva liberada, intento reconocido, reintentable (clase A, sin reconciliación); el reintento completa', async () => {
      const R = await freshRun('r62 503');
      const key = `audio_welcome:${R.cid}`;
      fakes.plan.ttsFail = [{ status: 503, message: 'service unavailable' }];
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome'));
      let row = await itemRow(R.rid, key);
      eq(row.status, 'retrying', `reintentable (${row.error})`);
      assert(/^tts_failed: chunk 1\/\d+: openai POST \/audio\/speech HTTP 503/.test(row.error) && !/reconciliation/.test(row.error), row.error);
      const resv = await reservationsOf(row.id, 'openai');
      assert(resv.length >= 1 && resv.every((x) => x.adj && Number(x.adj.amount) + Number(x.amount) === 0), 'reservas liberadas (0 gasto)');
      eq([row.failure_class, row.attention_reason], ['A', null], 'clase A, sin humano');
      await ds.query(`update public.generation_item_runs set next_retry_at = now() where id = $1`, [row.id]);
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome'));
      row = await itemRow(R.rid, key);
      eq(row.status, 'completed', `completa (${row.error})`);
    });

    const LONG_WELCOME = Array.from({ length: 40 }, (_, i) => `Esta es la oración ${i + 1} de la bienvenida al curso de hidráulica de planta, pensada para técnicos de mantenimiento.`).join(' ');
    const faulty = (obj, pred) => new Proxy(obj, { get(t, k) { const v = t[k]; if (typeof v !== 'function') return v; return (...a) => (pred(k, a) ? Promise.reject(new Error('EMAXCONNSESSION: db caída (simulada)')) : v.apply(t, a)); } });
    const ackOf = (row) => Number(row.output_summary?.reconciliationAcknowledgedThroughAttempt ?? 0);
    const orphansBehindAck = async (row) => (await reservationsOf(row.id, 'openai')).filter((x) => !x.adj && Number(x.attempt) <= ackOf(row));

    await check('review lost_result I1: bienvenida de 2 trozos, 529 en el trozo 2 → el trozo 1 COBRADO se liquida ANTES del ack (0 reservas detrás del ack); con la liquidación caída no hay ack (reconciliación) y el barrido lo resuelve: 0 reservas abiertas', async () => {
      const R = await freshRun('r62 529 trozo 2', { welcome: LONG_WELCOME });
      const key = `audio_welcome:${R.cid}`;
      fakes.plan.ttsFail = [undefined, 529];
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome'));
      let row = await itemRow(R.rid, key);
      eq([row.status, ackOf(row)], ['retrying', 1], `529 conocido: reintentable y reconocido (${row.error})`);
      eq((await orphansBehindAck(row)).length, 0, 'ninguna reserva cobrada detrás del ack');
      // Ahora con la DB del ledger caída en la liquidación (≈ kill entre liquidar y reconocer).
      const R2 = await freshRun('r62 529 trozo 2 sin ledger', { welcome: LONG_WELCOME });
      const key2 = `audio_welcome:${R2.cid}`;
      fakes.plan.ttsFail = [undefined, 529];
      await PW.processProviderItem(workerDeps({ finops: faulty(ledger, (k) => k === 'settleReservation') }), await claimProvider(R2.rid, 'audio_welcome')).catch(() => {});
      fakes.plan.ttsFail = [];
      let r2 = await itemRow(R2.rid, key2);
      eq([r2.status, ackOf(r2)], ['failed', 0], `sin ack (reconciliación): ${r2.error}`);
      eq((await orphansBehindAck(r2)).length, 0, 'nada detrás del ack');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(3) }), R2.rid).length, 1, 'el barrido lo toma (reenvío acotado)');
      await PW.processProviderItem(workerDeps(), await claimProvider(R2.rid, 'audio_welcome'));
      r2 = await itemRow(R2.rid, key2);
      eq(r2.status, 'completed', `completa (${r2.error})`);
      eq((await reservationsOf(r2.id, 'openai')).filter((x) => !x.adj).length, 0, '0 reservas abiertas');
    });

    await check('review lost_result: la SUBIDA del MP3 falla (Storage) → cobrado y liquidado sin resultado → lost_result a nivel worker: UN reenvío, solo el trozo perdido marcado; un 2.º perdido → excepción (sin otro reenvío)', async () => {
      const R = await freshRun('r62 subida caída');
      const key = `audio_welcome:${R.cid}`;
      const t0 = fakes.st.tts.length;
      await rejectsRe(PW.processProviderItem(workerDeps({ artifacts: faulty(artifacts, (k) => k === 'uploadBufferArtifact') }), await claimProvider(R.rid, 'audio_welcome')), /pagado sin persistir/, 'subida caída → resultado perdido');
      let row = await itemRow(R.rid, key);
      eq([row.status, AH.isLostPaidResultError(row.error)], ['failed', true], 'forma lost_result');
      eq((await reservationsOf(row.id, 'openai')).filter((x) => !x.adj).length, 0, 'lo cobrado quedó liquidado (registrado)');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(3) }), R.rid).length, 1, 'UN reenvío');
      row = await itemRow(R.rid, key);
      eq(row.output_summary.lostResultResend.lostChunks, [0], 'solo el trozo perdido');
      // El reenvío vuelve a perder el resultado (otra subida caída) → excepción, nunca un 2.º reenvío.
      await rejectsRe(PW.processProviderItem(workerDeps({ artifacts: faulty(artifacts, (k) => k === 'uploadBufferArtifact') }), await claimProvider(R.rid, 'audio_welcome')), /pagado sin persistir/, '2.º perdido');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(10) }), R.rid).length, 0, 'sin 2.º reenvío');
      row = await itemRow(R.rid, key);
      eq([row.status, row.attention_reason], ['failed', 'duplicate_charge'], 'excepción registrada');
      const marked = (await events(`item_run_id = $1 and provider = 'openai' and event_kind = 'CHARGE' and coalesce(metadata->>'reservation','false') <> 'true'`, [row.id])).filter((c) => c.metadata.lostResultResend === true);
      eq([marked.length, fakes.st.tts.length - t0], [1, 2], 'el cargo del reenvío marcado; 2 llamadas en total');
    });

    await check('review lost_result duda 3: el intento N+1 cae ANTES de llegar al proveedor (lease) → la marca la consume el intento que de verdad reenvía (N+2)', async () => {
      const R = await freshRun('r62 marca N+2');
      const key = `audio_welcome:${R.cid}`;
      const it = await itemRow(R.rid, key);
      const H = loadDist('workers/finops-worker-hooks.js');
      await ledger.recordCharge(H.ttsChargeInput({ ownerId: OWNER, itemRunId: it.id, requestId: 'req_r62_n2', audioSeconds: 4, characters: 60, model: 'gpt-4o-mini-tts-2025-03-20', generation: 1, chunk: 0, itemAttempt: 1 }));
      await ds.query(`update public.generation_item_runs set status = 'retrying', attempt_count = 1, max_attempts = 3, error = 'lease_expired', next_retry_at = now() - interval '1 second' where id = $1`, [it.id]);
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome')), /sin resultado persistido/, 'frenado');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(3) }), R.rid).length, 1, 'reabierto');
      // N+1 se reclama y su lease vence antes de llamar a OpenAI.
      const n1 = await claimProvider(R.rid, 'audio_welcome');
      await ds.query(`update public.generation_item_runs set lease_until = now() - interval '1 second' where id = $1`, [n1.itemRunId]);
      await sched.sweepExpiredLeases(R.rid);
      await ds.query(`update public.generation_item_runs set next_retry_at = now() - interval '1 second' where id = $1`, [n1.itemRunId]);
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome'));
      const row = await itemRow(R.rid, key);
      eq(row.status, 'completed', `completa (${row.error})`);
      const charges = await events(`item_run_id = $1 and provider = 'openai' and event_kind = 'CHARGE' and coalesce(metadata->>'reservation','false') <> 'true'`, [row.id]);
      eq(charges.filter((c) => c.metadata.lostResultResend === true).length, 1, 'el reenvío real (N+2) quedó marcado');
      eq([typeof row.output_summary.lostResultResend.consumedAttempt], ['number'], 'marca consumida');
    });

    await check('review lost_result: guion LLM del audiolibro COBRADO sin guardar (anthropic) → lost_result de punta a punta: UN reenvío, el cargo LLM nuevo marcado; una reserva LLM ENVIADA sin liquidar → provider_check (sin reenvío)', async () => {
      const R = await freshRun('r62 lost llm');
      const key = `audiobook_chapter:${R.c1}`;
      const it = await itemRow(R.rid, key);
      const H = loadDist('workers/finops-worker-hooks.js');
      await ledger.recordCharge(H.serverLlmChargeInput({ ownerId: OWNER, itemRunId: it.id, model: 'claude-sonnet-4-6', messageId: 'msg_r62_lost', requestId: null,
        usage: { input_tokens: 100, output_tokens: 200 }, callRole: 'main', attempt: 1 }));
      await ds.query(`update public.generation_item_runs set status = 'retrying', attempt_count = 1, max_attempts = 3, error = 'lease_expired', next_retry_at = now() - interval '1 second' where id = $1`, [it.id]);
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audiobook_chapter')), /^provider_reconciliation_required: anthropic .*sin resultado persistido/, 'frenado (anthropic)');
      const f = await itemRow(R.rid, key);
      eq(FC.classifyFailure({ error: f.error, itemType: 'audiobook_chapter', source: 'provider_worker' }).strategy, 'auto_resubmit_once', 'clasificador = barrido');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(3) }), R.rid).length, 1, 'UN reenvío');
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audiobook_chapter'));
      const row = await itemRow(R.rid, key);
      eq(row.status, 'completed', `completa (${row.error})`);
      const llm = await events(`item_run_id = $1 and provider = 'anthropic' and event_kind = 'CHARGE' and coalesce(metadata->>'reservation','false') <> 'true'`, [row.id]);
      eq(llm.filter((c) => c.metadata.lostResultResend === true).length, 1, 'un solo cargo LLM marcado (el reenviado)');
      eq((await events(`item_run_id = $1 and provider = 'openai' and event_kind = 'CHARGE' and coalesce(metadata->>'reservation','false') <> 'true'`, [row.id])).filter((c) => c.metadata.lostResultResend === true).length, 0, 'los segmentos nuevos (nunca pagados) sin marca');
    });

    await check('review lost_result M4: falla la liquidación de un segmento YA guardado → transitorio (no gasta el reenvío único); el próximo claim liquida el segmento con su medición y completa sin repagar', async () => {
      const R = await freshRun('r62 seg liquidación caída');
      const key = `audiobook_chapter:${R.c1}`;
      let n = 0;
      await PW.processProviderItem(workerDeps({ finops: faulty(ledger, (k, a) => k === 'settleReservation' && String(a[0]).includes(':seg_') && n++ === 0) }), await claimProvider(R.rid, 'audiobook_chapter')).catch(() => {});
      let row = await itemRow(R.rid, key);
      assert(row.status === 'retrying' && !/reconciliation/.test(String(row.error)), `transitorio (${row.status}: ${row.error})`);
      eq(row.output_summary.ambiguousAudioResubmit, undefined, 'el reenvío único no se tocó');
      const t0 = fakes.st.tts.length;
      await ds.query(`update public.generation_item_runs set next_retry_at = now() where id = $1`, [row.id]);
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audiobook_chapter'));
      row = await itemRow(R.rid, key);
      eq(row.status, 'completed', `completa (${row.error})`);
      assert(row.output_summary.reusedSegments >= 1, 'reutiliza el segmento guardado');
      eq((await reservationsOf(row.id, 'openai')).filter((x) => !x.adj).length, 0, '0 reservas abiertas');
      assert(fakes.st.tts.length - t0 < row.output_summary.chunks, 'no repagó el segmento guardado');
    });

    // ═══ E2E-M «resultado pagado perdido» (run_interrupt_resume, 2.ª vuelta) ═══════════
    await check('E2E-M lost_result: TTS de bienvenida COBRADO y liquidado sin el MP3 subido (kill entre liquidar y subir) → el barrido reenvía UNA vez solo, el cobro nuevo queda registrado como posible duplicado (lost_result) y la parte completa; un 2.º perdido → excepción', async () => {
      const R = await freshRun('r62 lost result');
      const key = `audio_welcome:${R.cid}`;
      const it = await itemRow(R.rid, key);
      const H = loadDist('workers/finops-worker-hooks.js');
      // Estado del kill: intento 1 con su cargo REAL liquidado (no reserva), ningún artifact.
      await ledger.recordCharge(H.ttsChargeInput({ ownerId: OWNER, itemRunId: it.id, requestId: 'req_r62_lost_1', audioSeconds: 4, characters: 60,
        model: 'gpt-4o-mini-tts-2025-03-20', generation: 1, chunk: 0, itemAttempt: 1 }));
      await ds.query(`update public.generation_item_runs set status = 'retrying', attempt_count = 1, max_attempts = 3, error = 'lease_expired', next_retry_at = now() - interval '1 second' where id = $1`, [it.id]);
      const t0 = fakes.st.tts.length;
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required: openai .*sin resultado persistido/, 'priorPaidBlock lo frena');
      eq(fakes.st.tts.length - t0, 0, 'sin llamar todavía');
      eq(AH.isLostPaidResultError((await itemRow(R.rid, key)).error), true, 'forma de resultado perdido');
      const res = await runs.autoResubmitAmbiguousAudio({ now: later(3) });
      eq(resubOf(res, R.rid).length, 1, 'UN reenvío automático');
      let row = await itemRow(R.rid, key);
      eq([row.output_summary.ambiguousAudioResubmit.cause, typeof row.output_summary.lostResultResend.afterAttempt], ['lost_result', 'number'], 'marca lost_result');
      eq((await attempts(row.id)).pop().strategy_applied, 'ambiguous_audio_resubmit:lost_result', 'log: system + motivo');
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome'));
      row = await itemRow(R.rid, key);
      eq(row.status, 'completed', `completa sola (${row.error})`);
      eq(fakes.st.tts.length - t0, 1, 'una sola llamada (el reenvío)');
      const charges = await events(`item_run_id = $1 and provider = 'openai' and event_kind = 'CHARGE' and coalesce(metadata->>'reservation','false') <> 'true'`, [row.id]);
      eq(charges.length, 2, 'el cargo perdido + el del reenvío (registrado, no oculto)');
      eq(charges.filter((c) => c.metadata.possibleDuplicate === true && c.metadata.lostResultResend === true).length, 1, 'el cobro nuevo = posible duplicado (lost_result)');
      eq((await reservationsOf(row.id, 'openai')).filter((x) => !x.adj).length, 0, '0 reservas abiertas');
      assert(await runSpent(R.rid) <= await paidAuthorized(R.rid), 'ledger ≤ autorizado');
      // Ya hubo un reenvío por resultado perdido → otro perdido es excepción (nunca un 2.º reenvío).
      eq(AH.ambiguousAudioResubmitDecision({ ...row, status: 'failed', error: row.output_summary.previousErrors.slice(-1)[0].error }, later(10), { pendingUsd: 0, providers: [], lostUsd: 0.01, lostProviders: ['openai'] }, undefined, FITS).reason, 'cap_reached', '2.º → excepción');
    });

    await check('E2E-M lost_result: el resubmitProvider MANUAL de un pagado ya liquidado marca su cobro nuevo como possible_duplicate', async () => {
      const R = await freshRun('r62 lost manual');
      const key = `audio_welcome:${R.cid}`;
      const it = await itemRow(R.rid, key);
      const H = loadDist('workers/finops-worker-hooks.js');
      await ledger.recordCharge(H.ttsChargeInput({ ownerId: OWNER, itemRunId: it.id, requestId: 'req_r62_lost_m', audioSeconds: 4, characters: 60,
        model: 'gpt-4o-mini-tts-2025-03-20', generation: 1, chunk: 0, itemAttempt: 1 }));
      await ds.query(`update public.generation_item_runs set status = 'retrying', attempt_count = 1, max_attempts = 3, error = 'lease_expired', next_retry_at = now() - interval '1 second' where id = $1`, [it.id]);
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome')), /sin resultado persistido/, 'frenado');
      await runs.retryItem(R.cid, OWNER, 1, R.rid, key, false, true, undefined, { id: 'admin-1', email: 'admin@cursia.test' });
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome'));
      const row = await itemRow(R.rid, key);
      eq(row.status, 'completed', `completa (${row.error})`);
      const charges = await events(`item_run_id = $1 and provider = 'openai' and event_kind = 'CHARGE' and coalesce(metadata->>'reservation','false') <> 'true'`, [row.id]);
      eq(charges.filter((c) => c.metadata.possibleDuplicate === true).length, 1, 'cobro nuevo marcado');
    });

    // ═══ E2E-M — kill -9 alrededor del envío (TTS del audiolibro) ═════════════════
    await check('E2E-M TTS: kill -9 entre la reserva y el envío → la reserva del segmento (sin marca de envío) se libera sola y la parte completa; kill después del envío → cobrada (possible_duplicate) + reenvío único; 0 reservas abiertas', async () => {
      // (a) muere entre reservar y enviar: simulado con una reserva marcada `sendMarked` del intento 1 sin `paidCallsSent`.
      const R = await freshRun('r62 kill antes del envío');
      const key = `audiobook_chapter:${R.c1}`;
      const it = await itemRow(R.rid, key);
      const H = loadDist('workers/finops-worker-hooks.js');
      const resKey = await H.reservePaidCall(ledger, { kind: 'tts', ownerId: OWNER, itemRunId: it.id, generation: 1, itemAttempt: 1, tag: 'seg:seg-0-0-deadbeef0000', estimate: { characters: 400, model: 'gpt-4o-mini-tts-2025-03-20' }, sendMarked: true });
      await ds.query(`update public.generation_item_runs set status = 'retrying', attempt_count = 1, max_attempts = 3, error = 'lease_expired', next_retry_at = now() - interval '1 second' where id = $1`, [it.id]);
      const t0 = fakes.st.tts.length;
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audiobook_chapter'));
      let row = await itemRow(R.rid, key);
      eq(row.status, 'completed', `completa (${row.error})`);
      const [orph] = await events(`idempotency_key = $1`, [resKey]);
      const [adj] = await events(`corrects_event_id = $1`, [orph.id]);
      eq([Number(adj.amount) + Number(orph.amount), adj.metadata.possibleDuplicate === true], [0, false], 'nunca enviada → liberada (sin gasto ni duplicado)');
      assert(fakes.st.tts.length - t0 >= 1, 'el audio se generó');
      // (b) muere DESPUÉS de enviar: reserva marcada y con su marca de envío, pasada la ventana en vuelo.
      const R2 = await freshRun('r62 kill después del envío');
      const key2 = `audiobook_chapter:${R2.c1}`;
      const it2 = await itemRow(R2.rid, key2);
      const resKey2 = await H.reservePaidCall(ledger, { kind: 'tts', ownerId: OWNER, itemRunId: it2.id, generation: 1, itemAttempt: 1, tag: 'seg:seg-0-0-deadbeef0001', estimate: { characters: 400, model: 'gpt-4o-mini-tts-2025-03-20' }, sendMarked: true });
      await ds.query(`update public.generation_item_runs set status = 'retrying', attempt_count = 1, max_attempts = 3, error = 'lease_expired', next_retry_at = now() - interval '1 second',
                       output_summary = coalesce(output_summary, '{}'::jsonb) || jsonb_build_object('paidCallsSent', jsonb_build_object($2::text, (now() - interval '1 hour')::text)) where id = $1`, [it2.id, resKey2]);
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R2.rid, 'audiobook_chapter')), /^provider_reconciliation_required: openai/, 'enviada → ambigua');
      eq(resubOf(await runs.autoResubmitAmbiguousAudio({ now: later(3) }), R2.rid).length, 1, 'reenvío único');
      await PW.processProviderItem(workerDeps(), await claimProvider(R2.rid, 'audiobook_chapter'));
      row = await itemRow(R2.rid, key2);
      eq(row.status, 'completed', `completa (${row.error})`);
      const [o2] = await events(`idempotency_key = $1`, [resKey2]);
      const [a2] = await events(`corrects_event_id = $1`, [o2.id]);
      eq([a2.metadata.possibleDuplicate, Number(a2.amount)], [true, 0], 'enviada → cobrada (posible duplicado, cuenta como gasto)');
      eq((await reservationsOf(row.id, 'openai')).filter((x) => !x.adj).length, 0, '0 reservas abiertas con la parte completa');
    });

    await check('K1: dos barridos A LA VEZ (dos ticks / reinicio) → UN solo reenvío y la liquidación possible_duplicate es idempotente', async () => {
      const R = await freshRun('r62 barridos concurrentes');
      fakes.plan.ttsFail = ['hang'];
      await rejectsRe(PW.processProviderItem(workerDeps({ env: FAST }), await claimProvider(R.rid, 'audio_welcome')), /^provider_reconciliation_required: openai/, 'timeout');
      fakes.plan.ttsFail = [];
      const both = await Promise.all([runs.autoResubmitAmbiguousAudio({ now: later(3) }), runs.autoResubmitAmbiguousAudio({ now: later(3) })]);
      eq(both.reduce((n, x) => n + resubOf(x, R.rid).length, 0), 1, 'un reenvío en total');
      const row = await itemRow(R.rid, `audio_welcome:${R.cid}`);
      eq([row.status, row.output_summary.ambiguousAudioResubmit.rounds, row.output_summary.previousErrors.length], ['pending', 1, 1], 'una sola reapertura');
      const resv = await reservationsOf(row.id, 'openai');
      for (const x of resv) eq((await events(`corrects_event_id = $1`, [x.id])).length <= 1, true, 'a lo sumo un ajuste por reserva');
    });

    // ═══ d2 + d3 — agotamiento de clase A ═══════════════════════════════════════
    const A_ERR = '❌ Falló después de 3 intentos: Error del servidor (503)';
    const failAt = (id, error, secAgo, osSql = null) => ds.query(
      `update public.generation_item_runs set status = 'failed', error = $2, worker_id = null, lease_until = null,
              finished_at = now() - make_interval(secs => $3::int)${osSql ? `, output_summary = ${osSql}` : ''} where id = $1`, [id, error, secAgo]);
    await check('d2 + d3: un A que ya agotó 5 rondas (antes → humano) se sigue reintentando con espera larga y sus dependientes se desbloquean solos; agotada la ventana de 72 h → excepción registrada', async () => {
      const R = await freshRun('r62 clase A');
      const key = `content:${R.c1}`;
      const it = await itemRow(R.rid, key);
      await failAt(it.id, A_ERR, 3600, `'{"autoHeal":{"rounds":5,"firstAt":"${new Date(Date.now() - 10 * 3600e3).toISOString()}"}}'::jsonb`);
      await runs.tx((qr) => T.blockDependents(qr, R.rid, key));
      const blocked = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'blocked' and $2 = any(depends_on)`, [R.rid, key]);
      assert(blocked.length > 0, 'hay dependientes bloqueados');
      const r6 = await runs.autoHealFailedItems({ now: new Date() });
      eq(r6.reopened.filter((x) => x.itemKey === key).map((x) => [x.round, !!x.extended]), [[6, true]], 'ronda 6 extendida');
      const still = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'blocked' and $2 = any(depends_on)`, [R.rid, key]);
      eq(still.length, 0, 'd3: dependientes desbloqueados con la reapertura');
      await failAt(it.id, A_ERR, 5 * 3600, `jsonb_set(output_summary, '{autoHeal,firstAt}', to_jsonb('${new Date(Date.now() - 73 * 3600e3).toISOString()}'::text))`);
      const rx = await runs.autoHealFailedItems({ now: new Date() });
      eq(rx.skipped.filter((x) => x.itemKey === key).map((x) => x.reason), ['recovery_window_exhausted'], 'ventana agotada');
      const row = await itemRow(R.rid, key);
      eq([row.status, row.attention_reason], ['failed', 'unrecoverable'], 'excepción registrada');
      const dto = await runs.getRun(R.cid, OWNER, 1, R.rid);
      assert((dto.completion.adminActions || []).some((x) => x.itemKey === key && x.code === 'retry_item'), 'acción humana visible al final');
    });

    // ═══ K3 — kill switch ═════════════════════════════════════════════════════
    await check('K3: FINOPS_KILL_SWITCH frena las partes (0 gasto) → mientras sigue activo esperan; al revertirlo se reabren solas (system, sin rondas del auto-healer) y sus dependientes se desbloquean', async () => {
      const R = await freshRun('r62 kill switch');
      const wKey = `audio_welcome:${R.cid}`;
      const cKey = `content:${R.c1}`;
      process.env.FINOPS_KILL_SWITCH = 'true';
      const t0 = fakes.st.tts.length;
      try {
        // Camino real del worker: la reserva se rechaza y no se llama a OpenAI.
        await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome'));
        let w = await itemRow(R.rid, wKey);
        assert(/FINOPS_KILL_SWITCH/.test(String(w.error)), `frenado por el kill switch: ${w.status} ${w.error}`);
        eq(fakes.st.tts.length - t0, 0, '0 llamadas');
        await failAt(w.id, w.error, 60);
        // Camino del navegador (mensaje de 04-api.js) en un content con dependientes.
        const c = await itemRow(R.rid, cKey);
        await failAt(c.id, 'finops_kill_switch: el interruptor de gasto del servidor (FINOPS_KILL_SWITCH) está activo: no se hacen llamadas pagadas nuevas (anthropic). No se hizo la llamada (sin gasto).', 60);
        await runs.tx((qr) => T.blockDependents(qr, R.rid, cKey));
        const s1 = await runs.autoResumeSpendControlHolds({ now: new Date() });
        eq([s1.resumed.filter((x) => x.runId === R.rid).length, s1.waiting.filter((x) => x.runId === R.rid).map((x) => x.code).sort()], [0, ['finops_kill_switch', 'finops_kill_switch']], 'activo: esperan');
        eq((await runs.autoHealFailedItems({ now: later(60) })).reopened.filter((x) => x.runId === R.rid).length, 0, 'el auto-healer no gasta rondas en esto');
        // M1: mientras espera, no hay acción humana para esas partes (ni retry_item).
        await runs.tx((qr) => T.recomputeRunStatus(qr, R.rid));
        const dto = await runs.getRun(R.cid, OWNER, 1, R.rid);
        assert(!(dto.completion.adminActions || []).some((x) => x.itemKey === wKey || x.itemKey === cKey), `sin acciones para las partes frenadas: ${JSON.stringify(dto.completion.adminActions)}`);
      } finally {
        delete process.env.FINOPS_KILL_SWITCH;
      }
      const s2 = await runs.autoResumeSpendControlHolds({ now: new Date() });
      eq(s2.resumed.filter((x) => x.runId === R.rid).map((x) => x.itemKey).sort(), [wKey, cKey].sort(), 'revertido: reabiertas solas');
      const w = await itemRow(R.rid, wKey);
      eq([w.status, w.output_summary.spendControlResume.count], ['pending', 1], 'reabierta');
      const last = (await attempts(w.id)).pop();
      eq([last.actor, last.strategy_applied], ['system', 'spend_control_resume:finops_kill_switch'], 'log: system + motivo');
      const still = await ds.query(`select item_key from public.generation_item_runs where job_id = $1 and status = 'blocked' and $2 = any(depends_on)`, [R.rid, cKey]);
      eq(still.length, 0, 'd3: dependientes desbloqueados');
      await PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'audio_welcome'));
      eq((await itemRow(R.rid, wKey)).status, 'completed', 'la bienvenida completa');
    });

    // ═══ d8 — claim_payload_unavailable ═════════════════════════════════════════
    await check('d8: claim_payload_unavailable de video_interactions — dependencia completada → reabre gratis; dato inutilizable → regenerate_dependency UNA vez (system, cascada) y una 2.ª vez → excepción', async () => {
      const R = await freshRun('r62 claim', { videos: true });
      const vKey = `video:${R.c1}`;
      const iKey = `video_interactions:${R.c1}`;
      const v = await itemRow(R.rid, vKey);
      const iv = await itemRow(R.rid, iKey);
      assert(v && iv, 'video + interacciones en el Manifest');
      // 1) VIDEO_NOT_COMPLETED con el video ya completo (carrera) → reabrir.
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() - interval '1 minute' where id = $1`, [v.id]);
      await failAt(iv.id, `claim_payload_unavailable: VIDEO_NOT_COMPLETED: el video ${vKey} no está completado`, 300);
      const r1 = await runs.autoRecoverClaimPayloadUnavailable({ now: new Date() });
      eq(r1.reopened, [iKey], 'reabierto');
      let row = await itemRow(R.rid, iKey);
      eq([row.status, row.output_summary.claimPayloadRecovery.reopens], ['pending', 1], 'pending');
      eq((await attempts(row.id)).pop().actor, 'system', 'system');
      // 2) dato inutilizable (sin youtubeId) → regenerar la dependencia una vez.
      await failAt(iv.id, `claim_payload_unavailable: VIDEO_YOUTUBE_ID_MISSING: el video ${vKey} no tiene youtubeId`, 30);
      await ds.query(`update public.generation_item_runs set finished_at = now() - interval '10 minutes' where id = $1`, [v.id]);
      const r2 = await runs.autoRecoverClaimPayloadUnavailable({ now: new Date() });
      eq([r2.regenerated, r2.exceptions], [[vKey], []], `regenerada la dependencia (${JSON.stringify(r2)})`);
      const v2 = await itemRow(R.rid, vKey);
      eq([Number(v2.generation), v2.output_summary.regeneration.reason, v2.status], [2, 'claim_payload_dependency', 'pending'], 'generación nueva del video');
      const iv2 = await itemRow(R.rid, iKey);
      assert(Number(iv2.generation) === 2 && iv2.status !== 'failed', `cascada: interacciones regeneradas (${iv2.generation} ${iv2.status})`);
      eq((await attempts(v2.id)).pop().strategy_applied, 'regenerate_dependency:claim_payload', 'log: estrategia');
      // 3) vuelve a faltar el dato sobre la generación nueva → no hay 2.ª regeneración: excepción.
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() - interval '10 minutes' where id = $1`, [v2.id]);
      await failAt(iv2.id, `claim_payload_unavailable: VIDEO_YOUTUBE_ID_MISSING: el video ${vKey} no tiene youtubeId`, 30);
      const r3 = await runs.autoRecoverClaimPayloadUnavailable({ now: new Date() });
      eq([r3.regenerated, r3.exceptions.map((x) => x.reason)], [[], ['already_regenerated']], 'excepción');
      row = await itemRow(R.rid, iKey);
      eq([row.status, row.attention_reason, row.output_summary.claimPayloadRecovery.declined], ['failed', 'unrecoverable', 'already_regenerated'], 'excepción registrada');
      // re-review 4 M1: dependencia CANCELADA → sin `declined` (se re-evalúa en cada tick), atención dependency_unavailable;
      // si la dependencia revive y completa, la parte se reabre sola.
      const R4 = await freshRun('r62 claim dep cancelada', { videos: true });
      const v4 = await itemRow(R4.rid, `video:${R4.c1}`);
      const i4 = await itemRow(R4.rid, `video_interactions:${R4.c1}`);
      await ds.query(`update public.generation_item_runs set status = 'cancelled', finished_at = now() - interval '1 minute' where id = $1`, [v4.id]);
      await failAt(i4.id, `claim_payload_unavailable: VIDEO_YOUTUBE_ID_MISSING: el video video:${R4.c1} no tiene youtubeId`, 30);
      for (let t = 0; t < 2; t++) {
        const rr = await runs.autoRecoverClaimPayloadUnavailable({ now: new Date() });
        eq(rr.exceptions.filter((x) => x.reason === 'dependency_unavailable').length >= 1, true, `tick ${t}: excepción (re-evaluada)`);
      }
      let x4 = await itemRow(R4.rid, i4.item_key);
      eq([x4.status, x4.attention_reason, !!(x4.output_summary.claimPayloadRecovery && x4.output_summary.claimPayloadRecovery.declined)], ['failed', 'dependency_unavailable', false], 'sin declined, atención explícita');
      await ds.query(`update public.generation_item_runs set status = 'completed', finished_at = now() where id = $1`, [v4.id]);
      const rv = await runs.autoRecoverClaimPayloadUnavailable({ now: new Date() });
      eq(rv.reopened.includes(i4.item_key), true, 'la dependencia revivió → reabierta sola');
      x4 = await itemRow(R4.rid, i4.item_key);
      eq([x4.status, x4.attention_reason], ['pending', null], 'reabierta (atención limpia)');
    });

    // ═══ Integración N1 × N2: sin doble liquidación ═══════════════════════════════
    await check('integración N1×N2: Gamma SIN generationId (envío ambiguo) + reenvío explícito → la reserva queda cobrada (possible_duplicate) UNA vez; una conciliación posterior (vía N2) es no-op: un solo ADJUSTMENT', async () => {
      const R = await freshRun('r62 gamma ambiguo');
      fakes.plan.gammaPostFail = ['noid'];
      await rejectsRe(PW.processProviderItem(workerDeps(), await claimProvider(R.rid, 'presentation')), /^gamma_submit_ambiguous/, 'ambiguo sin id');
      const row = await itemRow(R.rid, `presentation:${R.c1}`);
      const pend = (await reservationsOf(row.id, 'gamma')).filter((x) => !x.adj);
      eq(pend.length, 1, 'reserva de Gamma pendiente');
      await runs.retryItem(R.cid, OWNER, 1, R.rid, row.item_key, false, true, undefined, { id: 'admin-1', email: 'admin@cursia.test' });
      let adjs = await events(`corrects_event_id = $1`, [pend[0].id]);
      eq([adjs.length, adjs[0].metadata.possibleDuplicate, adjs[0].metadata.decidedBy], [1, true, 'admin-1'], 'sin id → vía N1 (possible_duplicate)');
      const again = await ledger.reconcileReservationAsCharged(pend[0].idempotency_key, 'n2: evidencia', { decidedBy: 'system' });
      const partial = await ledger.reconcileReservationAsChargedPartial(pend[0].idempotency_key, '0.10', 'n2: créditos', { kind: 'provider_api_response', source: 'gamma', observedAt: new Date().toISOString(), amount: '0.10' }, { decidedBy: 'system' }).catch((e) => ({ error: e.message }));
      adjs = await events(`corrects_event_id = $1`, [pend[0].id]);
      eq([again.alreadySettled, partial.alreadySettled === true || !!partial.error, adjs.length], [true, true, 1], `ninguna segunda liquidación (${JSON.stringify(partial)})`);
    });

    await check('integración N1×N2: Gamma CON generationId → el reenvío explícito NO la liquida por la vía conservadora (la concilia N2 con evidencia)', async () => {
      const R = await freshRun('r62 gamma con id');
      const it = await itemRow(R.rid, `presentation:${R.c1}`);
      const H = loadDist('workers/finops-worker-hooks.js');
      const key = await H.reservePaidCall(ledger, { kind: 'gamma', ownerId: OWNER, itemRunId: it.id, generation: 1, itemAttempt: 1, tag: 'submit', estimate: {} });
      await ds.query(`update public.generation_item_runs set status = 'failed', attempt_count = 1, error = 'gamma_generation_failed: fake failure. No se reenvía sola',
                       output_summary = jsonb_build_object('external', jsonb_build_object('gammaGenerationId', 'gen_r62_1'), 'externalReservationKey', $2::text, 'externalSubmitStartedAt', now()::text), finished_at = now() where id = $1`, [it.id, key]);
      await runs.retryItem(R.cid, OWNER, 1, R.rid, it.item_key, false, true, undefined, { id: 'admin-1', email: 'admin@cursia.test' });
      const [res] = await events(`idempotency_key = $1`, [key]);
      eq((await events(`corrects_event_id = $1`, [res.id])).length, 0, 'con id consultable: la vía N1 no escribe nada');
    });

    assert(!LOGS.some((l) => Object.values(SECRETS).some((s) => l.includes(s))), 'ninguna clave en los logs');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (ds) await ds.destroy().catch(() => {});
    await fakes.close().catch(() => {});
    await new Promise((r) => storage.srv.close(() => r()));
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    console.log('PG16 descartable destruido');
  }
}

(async () => {
  await pureChecks();
  if (!PURE_ONLY) await dbChecks().catch((e) => { failures++; console.error(`❌ DB: ${e && e.stack ? e.stack : e}`); });
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})();
