#!/usr/bin/env node
/* eslint-disable */
// r59 — confiabilidad del TTS de OpenAI (run 1c02fd27 / curso #1510: el segmento seg-0-0 del audiolibro venció el
// timeout de 120 s DOS veces —el intento original y el reenvío automático #583— y dejó dos reservas pendientes).
//
// Sin red y sin gasto: funciones puras + el controlador con un ledger FALSO en memoria.
//   (d) auto-heal: el reenvío automático ÚNICO de audio incierto declina un timeout del cliente
//       (`timeout_likely_charged`) y sigue aceptando otro corte ambiguo (conexión caída);
//   (e) POST finops/tts-reservations/reconcile: validación (400), reserva que no es de TTS, parte en ejecución (409),
//       decisión charged / not_charged con metadata { ttsReservation: true }, repetir = no-op; SUPER_ADMIN.
//
// Usage: node scripts/check-r59-tts-reliability.js [path/to/dist]
const path = require('path');

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
const AH = loadDist('modules/dynamic-generation/auto-heal.js');
const FC = loadDist('modules/reliability/failure-classifier.js');
const CTRL = loadDist('modules/finops/finops.controller.js');
const LEDGER = loadDist('modules/finops/finops-ledger.service.js');
const { SuperAdminGuard } = loadDist('auth/super-admin.guard.js');
const { BadRequestException, ConflictException } = require('@nestjs/common');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
async function rejects(p, Cls, re, m) {
  try { await p; } catch (err) {
    assert(err instanceof Cls, `${m}: esperaba ${Cls.name}, fue ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
    if (re) assert(re.test(String(err.message)), `${m}: mensaje «${err.message}»`);
    return;
  }
  throw new Error(`${m}: no lanzó`);
}

const RECON = 'provider_reconciliation_required: openai — llamada pagada enviada sin resultado liquidado.';
const TAIL = ' El proveedor pudo haber completado (y cobrado) la operación: quedó reservada en el ledger y NO se reintenta sola. ' +
  'Revisa la cuenta del proveedor y resuelve explícitamente (retry con resubmitProvider/resubmitVideo=true).';
const NOW = new Date('2026-10-19T15:20:00Z');
const rowOf = (error, type = 'audiobook_chapter') => ({
  status: 'failed', type, error, output_summary: {}, finished_at: new Date(NOW.getTime() - 300_000).toISOString(),
});
const PENDING = { pendingUsd: 0.0735, providers: ['openai'] };

(async () => {
  // ── (d) auto-heal ──────────────────────────────────────────────────────────
  await check('(d) timeout del cliente (#1510: «aborted due to timeout» / TimeoutError) → el reenvío automático declina (timeout_likely_charged); el clasificador no lo ofrece como reenvío automático', () => {
    const errs = [
      `${RECON} tts_failed: chunk 1/7 (persisted 0): The operation was aborted due to timeout${TAIL}`,
      `${RECON} tts_failed: chunk 1/7 (persisted 0): openai POST /audio/speech: error de red (TimeoutError)${TAIL}`,
      `${RECON} tts_failed: chunk 2/3 (persisted 1): request timeout${TAIL}`,
    ];
    for (const e of errs) {
      for (const type of ['audiobook_chapter', 'audio_welcome']) {
        const d = AH.ambiguousAudioResubmitDecision(rowOf(e, type), NOW, PENDING);
        eq([d.heal, d.reason], [false, 'timeout_likely_charged'], `${type}: ${e.slice(90, 160)}`);
        // Sin consultar el ledger (run-completion / clasificador): misma respuesta.
        eq(AH.ambiguousAudioResubmitDecision(rowOf(e, type), NOW).reason, 'timeout_likely_charged', 'sin ledger');
        assert(FC.currentRecoveryOf(e, type, {}) !== 'ambiguous_audio_resubmit', `clasificador: ${type}`);
      }
    }
  });

  await check('(d) otro corte ambiguo (conexión caída antes de la respuesta) → el reenvío automático ÚNICO sigue igual (heal tras la espera, ≤ USD 0.10)', () => {
    const errs = [
      `${RECON} tts_failed: chunk 1/7 (persisted 0): openai POST /audio/speech: error de red (TypeError)${TAIL}`,
      `${RECON} tts_failed: chunk 3/4 (persisted 2): socket hang up (ECONNRESET)${TAIL}`,
      'provider_reconciliation_required: openai — audio TTS pagado sin persistir. El proveedor pudo haber completado',
    ];
    for (const e of errs) {
      const d = AH.ambiguousAudioResubmitDecision(rowOf(e), NOW, PENDING);
      eq([d.heal, d.round], [true, 1], e.slice(90, 160));
      assert(FC.currentRecoveryOf(e, 'audiobook_chapter', {}) === 'ambiguous_audio_resubmit', 'clasificador: reenvío automático');
    }
    // Las demás reglas no cambian.
    eq(AH.ambiguousAudioResubmitDecision(rowOf(errs[0]), NOW, { pendingUsd: 0.11, providers: ['openai'] }).reason, 'over_threshold', 'tope');
    eq(AH.ambiguousAudioResubmitDecision(rowOf(errs[0], 'video'), NOW, PENDING).reason, 'not_audio', 'video');
    eq(AH.ambiguousAudioResubmitDecision({ ...rowOf(errs[0]), output_summary: { ambiguousAudioResubmit: { rounds: 1 } } }, NOW, PENDING).reason, 'cap_reached', 'una sola vez');
    assert(!AH.AMBIGUOUS_AUDIO_TIMEOUT_RE.test(TAIL) && !AH.AMBIGUOUS_AUDIO_TIMEOUT_RE.test(RECON), 'el texto fijo de la reconciliación no cuenta como timeout');
    assert(!AH.AMBIGUOUS_AUDIO_TIMEOUT_RE.test('connect ETIMEDOUT 1.2.3.4:443'), 'ETIMEDOUT (conexión, antes de enviar) no es un timeout de respuesta');
  });

  // ── (e) conciliación de reservas de TTS ────────────────────────────────────
  const IR = '0f3c2a1b-1111-4222-8333-444455556666';
  const KEY = `reservation:tts:${IR}:g1:a1:seg_seg-0-0-0123456789ab`;
  const KEY_RUN = `reservation:tts:${IR}:g1:a2:seg_seg-0-0-0123456789ab`;
  const KEY_LLM = `reservation:tts:${IR}:g1:a1:not-a-reservation`;

  await check('(e) validación del cuerpo: clave inválida / de otro tipo, outcome, reason y campos extra → 400', () => {
    const P = CTRL.parseTtsReservationReconcileBody;
    const bad = [
      [{ reservationKey: `reservation:llm:${IR}:g1:a1:sec0-main`, outcome: 'charged', reason: 'x' }, /reservationKey/],
      [{ reservationKey: 'reservation:tts:nope:g1', outcome: 'charged', reason: 'x' }, /reservationKey/],
      [{ reservationKey: `${KEY}; drop table`, outcome: 'charged', reason: 'x' }, /reservationKey/],
      [{ reservationKey: KEY, outcome: 'maybe', reason: 'x' }, /outcome/],
      [{ reservationKey: KEY, outcome: 'charged', reason: '  ' }, /reason/],
      [{ reservationKey: KEY, outcome: 'charged', reason: 'x'.repeat(501) }, /reason/],
      [{ reservationKey: KEY, outcome: 'charged', reason: 'x', force: true }, /campo no permitido/],
      [null, /reservationKey/],
      [[KEY], /reservationKey/],
    ];
    for (const [body, re] of bad) {
      let threw = null;
      try { P(body); } catch (e) { threw = e; }
      assert(threw instanceof BadRequestException && re.test(threw.message), `${JSON.stringify(body).slice(0, 80)} → ${threw && threw.message}`);
    }
    eq(P({ reservationKey: KEY, outcome: 'not_charged', reason: 'consola OpenAI sin cobro' }), { reservationKey: KEY, outcome: 'not_charged', reason: 'consola OpenAI sin cobro' }, 'válido');
    assert(LEDGER.TTS_RESERVATION_KEY_RE.test(KEY), 'clave real (reservationKey de finops-worker-hooks) aceptada');
  });

  await check('(e) decisión del ledger: no existe / no es reserva → not_tts; parte running|claimed → item_running; si no → ok (sin DB: fila falsa)', async () => {
    eq(LEDGER.ttsReservationCheckOf(null), 'not_tts', 'sin fila');
    eq(LEDGER.ttsReservationCheckOf({ item_status: 'running' }), 'item_running', 'running');
    eq(LEDGER.ttsReservationCheckOf({ item_status: 'claimed' }), 'item_running', 'claimed');
    for (const s of ['failed', 'retrying', 'completed', '']) eq(LEDGER.ttsReservationCheckOf({ item_status: s }), 'ok', s || '(sin item)');
    // isTtsReservation con un dataSource falso: la consulta exige CHARGE + reservation = true por clave.
    const seen = [];
    const ds = { query: async (sql, params) => { seen.push([sql, params]); return params[0] === KEY ? [{ item_status: 'failed' }] : []; } };
    const svc = new LEDGER.FinopsLedgerService(ds);
    eq(await svc.isTtsReservation(KEY), 'ok', 'reserva pendiente fuera de ejecución');
    eq(await svc.isTtsReservation(KEY_LLM), 'not_tts', 'no es reserva CHARGE');
    eq(await svc.isTtsReservation(`reservation:llm:${IR}:g1:a1:x`), 'not_tts', 'otra clase de reserva (sin consultar)');
    assert(/event_kind = 'CHARGE'/.test(seen[0][0]) && /'reservation'\) = 'true'/.test(seen[0][0]), 'filtro de la consulta');
    eq(seen.length, 2, 'la clave de otro tipo no llega a la DB');
  });

  await check('(e) endpoint: SUPER_ADMIN; not_tts → 400; parte en ejecución → 409 (sin conciliar); charged / not_charged con { ttsReservation: true }; repetir = no-op', async () => {
    const guards = Reflect.getMetadata('__guards__', CTRL.FinopsAdminController) || [];
    assert(guards.includes(SuperAdminGuard), 'el controlador de admin exige SuperAdminGuard');
    const proto = CTRL.FinopsAdminController.prototype;
    eq(Reflect.getMetadata('path', proto.reconcileTtsReservation), 'tts-reservations/reconcile', 'ruta POST');
    eq(Reflect.getMetadata('path', proto.ttsReservations), 'tts-reservations', 'ruta GET');

    const settled = new Map();
    const calls = [];
    const fakeLedger = {
      isTtsReservation: async (k) => (k === KEY ? 'ok' : k === KEY_RUN ? 'item_running' : 'not_tts'),
      reconcileReservationAsCharged: async (k, reason, opts) => {
        calls.push(['charged', k, reason, opts]);
        if (settled.has(k)) return { reconciled: false, alreadySettled: true, amount: '0.0735' };
        settled.set(k, 'charged');
        return { reconciled: true, alreadySettled: false, amount: '0.0735' };
      },
      reconcileReservationAsNotCharged: async (k, reason, opts) => {
        calls.push(['not_charged', k, reason, opts]);
        if (settled.has(k)) return { reconciled: false, alreadySettled: true, amount: '0.0735' };
        settled.set(k, 'not_charged');
        return { reconciled: true, alreadySettled: false, amount: '0.0735' };
      },
      pendingTtsReservations: async (f) => [{ reservationKey: KEY, filter: f }],
    };
    const ctrl = new CTRL.FinopsAdminController(fakeLedger, {});
    const admin = { id: 'admin-uuid', email: 'x@y' };
    await rejects(ctrl.reconcileTtsReservation({ reservationKey: KEY_LLM, outcome: 'charged', reason: 'r' }, admin), BadRequestException, /no es una reserva de TTS/, 'not_tts');
    await rejects(ctrl.reconcileTtsReservation({ reservationKey: KEY_RUN, outcome: 'charged', reason: 'r' }, admin), ConflictException, /en ejecución/, 'item_running');
    await rejects(ctrl.reconcileTtsReservation({ reservationKey: KEY, outcome: 'charged', reason: 'r' }, {}), BadRequestException, /usuario sin id/, 'sin id');
    eq(calls.length, 0, 'nada conciliado en los rechazos');
    const r1 = await ctrl.reconcileTtsReservation({ reservationKey: KEY, outcome: 'charged', reason: 'OpenAI lo cobró (consola)' }, admin);
    eq(r1, { outcome: 'charged', reconciled: true, alreadySettled: false, amount: '0.0735' }, 'charged');
    eq(calls[0][3], { decidedBy: 'admin-uuid', metadata: { ttsReservation: true } }, 'decidedBy = id (nunca el email) + metadata');
    const r2 = await ctrl.reconcileTtsReservation({ reservationKey: KEY, outcome: 'not_charged', reason: 'repetido' }, admin);
    eq([r2.reconciled, r2.alreadySettled], [false, true], 'repetir = no-op');
    eq(settled.get(KEY), 'charged', 'la primera decisión se conserva');
    const list = await ctrl.ttsReservations('1510', undefined);
    eq(list.reservations[0].filter, { courseId: 1510 }, 'GET con filtro de curso');
    await rejects(ctrl.ttsReservations('x', undefined), BadRequestException, /courseId/, 'GET courseId inválido');
  });

  console.log(`\n${passes} OK, ${failures} con fallas`);
  process.exit(failures ? 1 : 0);
})();
