#!/usr/bin/env node
/* eslint-disable */
// r59 — confiabilidad del TTS de OpenAI (run 1c02fd27 / curso #1510: el segmento seg-0-0 del audiolibro venció el
// timeout de 120 s DOS veces —el intento original y el reenvío automático #583— y dejó dos reservas pendientes).
//
// Sin red y sin gasto: funciones puras + el controlador con un ledger FALSO en memoria.
//   (d) auto-heal: el reenvío automático ÚNICO de audio incierto — r62: también un timeout del cliente (antes
//       `timeout_likely_charged` → admin), siempre con el peor caso dentro de lo autorizado; otro corte ambiguo igual;
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
  // r62 (K1, regla de ambigüedad acotada — cambio DELIBERADO de r59): un timeout del cliente ya NO va a un admin
  // (`timeout_likely_charged` dejó de existir). Igual que un corte de conexión: UN reenvío automático, solo si el peor caso
  // entra en lo autorizado (presupuesto de la parte + saldo del run), con la reserva perdida liquidada como posible duplicado.
  const FITS = { fits: true, reason: null };
  await check('(d) r62: timeout del cliente (#1510: «aborted due to timeout» / TimeoutError) → UN reenvío automático acotado (causa timeout_presumed_charged); el clasificador lo informa como reenvío automático', () => {
    const errs = [
      `${RECON} tts_failed: chunk 1/7 (persisted 0): The operation was aborted due to timeout${TAIL}`,
      `${RECON} tts_failed: chunk 1/7 (persisted 0): openai POST /audio/speech: error de red (TimeoutError)${TAIL}`,
    ];
    for (const e of errs) {
      for (const type of ['audiobook_chapter', 'audio_welcome']) {
        const d = AH.ambiguousAudioResubmitDecision(rowOf(e, type), NOW, PENDING, undefined, { budget: FITS });
        eq([d.heal, d.round, d.cause], [true, 1, 'timeout_presumed_charged'], `${type}: ${e.slice(90, 160)}`);
        // Sin consultar el ledger (run-completion / clasificador): el servidor lo va a resolver solo.
        eq(AH.ambiguousAudioResubmitDecision(rowOf(e, type), NOW).heal, true, 'sin ledger');
        assert(FC.currentRecoveryOf(e, type, {}) === 'ambiguous_audio_resubmit', `clasificador: ${type}`);
        // Peor caso fuera de lo autorizado → excepción (no reenvío), y sin evaluación del presupuesto nunca reenvía.
        eq(AH.ambiguousAudioResubmitDecision(rowOf(e, type), NOW, PENDING, undefined, { budget: { fits: false, reason: 'item_recovery_budget' } }).reason, 'over_budget', 'fuera del presupuesto');
        eq(AH.ambiguousAudioResubmitDecision(rowOf(e, type), NOW, PENDING, undefined, { budget: null }).reason, 'over_budget', 'sin presupuesto evaluado');
      }
    }
    // «request timeout» (texto libre del cuerpo) ya no se lee como timeout del cliente (K2): causa connection_cut.
    eq(AH.ambiguousAudioCause(`${RECON} tts_failed: chunk 2/3 (persisted 1): request timeout${TAIL}`), 'connection_cut', 'texto libre');
  });

  await check('(d) otro corte ambiguo (conexión caída antes de la respuesta) → el reenvío automático ÚNICO sigue igual (heal tras la espera, dentro de lo autorizado)', () => {
    const errs = [
      `${RECON} tts_failed: chunk 1/7 (persisted 0): openai POST /audio/speech: error de red (TypeError)${TAIL}`,
      `${RECON} tts_failed: chunk 3/4 (persisted 2): socket hang up (ECONNRESET)${TAIL}`,
      // Caso real de #1353 (2026-10-14): socket cortado a mitad del cuerpo; el reenvío automático lo recuperó.
      `${RECON} tts_failed: chunk 6/6 (persisted 5): terminated${TAIL}`,
      'provider_reconciliation_required: openai — audio TTS pagado sin persistir. El proveedor pudo haber completado',
    ];
    for (const e of errs) {
      const d = AH.ambiguousAudioResubmitDecision(rowOf(e), NOW, PENDING, undefined, { budget: FITS });
      eq([d.heal, d.round, d.cause], [true, 1, 'connection_cut'], e.slice(90, 160));
      assert(FC.currentRecoveryOf(e, 'audiobook_chapter', {}) === 'ambiguous_audio_resubmit', 'clasificador: reenvío automático');
    }
    // Las demás reglas no cambian (el tope fijo de USD 0,10 ya no existe: solo un tope OPCIONAL de operación).
    eq(AH.ambiguousAudioResubmitDecision(rowOf(errs[0]), NOW, { pendingUsd: 0.11, providers: ['openai'] }, undefined, { budget: FITS }).heal, true, 'sin tope fijo');
    eq(AH.ambiguousAudioResubmitDecision(rowOf(errs[0]), NOW, { pendingUsd: 0.11, providers: ['openai'] }, undefined, { budget: FITS, maxUsd: 0.1 }).reason, 'over_threshold', 'tope opcional');
    eq(AH.ambiguousAudioResubmitDecision(rowOf(errs[0], 'video'), NOW, PENDING).reason, 'not_audio', 'video');
    eq(AH.ambiguousAudioResubmitDecision({ ...rowOf(errs[0]), output_summary: { ambiguousAudioResubmit: { rounds: 1 } } }, NOW, PENDING).reason, 'cap_reached', 'una sola vez');
    assert(!AH.AMBIGUOUS_AUDIO_TIMEOUT_RE.test(TAIL) && !AH.AMBIGUOUS_AUDIO_TIMEOUT_RE.test(RECON), 'el texto fijo de la reconciliación no cuenta como timeout');
    assert(!AH.AMBIGUOUS_AUDIO_TIMEOUT_RE.test('connect ETIMEDOUT 1.2.3.4:443'), 'ETIMEDOUT (conexión, antes de enviar) no es un timeout de respuesta');
    // K2: el cuerpo de un 5xx que menciona «timeout» no es un timeout del cliente.
    assert(!AH.AMBIGUOUS_AUDIO_TIMEOUT_RE.test('openai POST /audio/speech HTTP 504: upstream request timeout'), '504 con cuerpo');
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
      // r60 (I1): decisión registrada (para distinguir el no-op del 409).
      reservationDecisionOf: async (k) => (settled.has(k) ? { settlement: `reconciled_as_${settled.get(k)}`, countedAmount: settled.get(k) === 'charged' ? '0.0735000000' : '0.0000000000' } : null),
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
    const r2 = await ctrl.reconcileTtsReservation({ reservationKey: KEY, outcome: 'charged', reason: 'repetido' }, admin);
    eq([r2.reconciled, r2.alreadySettled], [false, true], 'repetir la misma decisión = no-op');
    // r60 (I1): la decisión inversa sobre una reserva ya conciliada → 409 (antes: 200 alreadySettled).
    await rejects(ctrl.reconcileTtsReservation({ reservationKey: KEY, outcome: 'not_charged', reason: 'cambio' }, admin), ConflictException, /reservation_already_settled/, 'inversa → 409');
    eq(settled.get(KEY), 'charged', 'la primera decisión se conserva');
    const list = await ctrl.ttsReservations('1510', undefined);
    eq(list.reservations[0].filter, { courseId: 1510 }, 'GET con filtro de curso');
    await rejects(ctrl.ttsReservations('x', undefined), BadRequestException, /courseId/, 'GET courseId inválido');
  });

  console.log(`\n${passes} OK, ${failures} con fallas`);
  process.exit(failures ? 1 : 0);
})();
