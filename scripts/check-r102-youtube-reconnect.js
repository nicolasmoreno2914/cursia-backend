#!/usr/bin/env node
/* eslint-disable */
// r102 — El canal de YouTube del creador se desconectó (token vencido / revocado): el creador NUNCA necesita a un admin.
//
//   U  bug-hold puro: una pausa de la regla youtube_auth pide reconectar (mensaje + acción), espera la reconexión y se
//      reanuda sola con `youtube_reconnected` cuando la conexión ACTIVA del owner es posterior a la pausa (fuera del tope
//      automático, nunca con pago incierto); las demás pausas no cambian;
//   PG Postgres 16 REAL (scripts/lib/r95-db.js): fallo youtube_blocked_auth → pausa; DTO de la parte y del run con el
//      mensaje de reconexión; barrido sin reconexión → sigue en pausa; conexión vieja → sigue; reconexión → retryItem la
//      reabre (pending); sin la tabla youtube_connections el barrido no se rompe; todo el SQL nuevo se ejecuta.
// USD 0: proveedores falsos, red bloqueada salvo 127.0.0.1.
// Uso: npm run build && node scripts/check-r102-youtube-reconnect.js [--no-pg]
'use strict';
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { const s = String(u); if (/^http:\/\/127\.0\.0\.1:\d+/.test(s)) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${s}`); };
const path = require('path');

const NO_PG = process.argv.slice(2).includes('--no-pg');
const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const L = (rel) => { try { return require(path.join(DIST, rel)); } catch (err) { console.error(`❌ No se pudo cargar dist/${rel} (¿npm run build?): ${err.message}`); process.exit(1); } };

const FC = L('modules/reliability/failure-classifier.js');
const BH = L('modules/reliability/bug-hold.js');

let passes = 0;
let failures = 0;
async function check(name, fn) { try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n   ') : err}`); } }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || 'eq'}: ${x} !== ${y}`); }

const YT_ERR = 'youtube_blocked_auth: La conexión con YouTube expiró o fue revocada. Vuelve a conectar tu canal en la sección Cuenta.';
const UNK = 'r102_codigo_sin_regla: algo raro';

(async () => {
  const T0 = new Date('2026-11-06T15:00:00Z');
  const at = (min) => new Date(T0.getTime() + min * 60_000);
  const verdictOf = (error, itemType = 'video') => FC.classifyFailure({ error, itemType, outputSummary: {}, source: 'server_worker' });
  const heldRow = (error, extra = {}) => {
    const v = verdictOf(error);
    const im = BH.holdsImmediately(v);
    const hold = { ...BH.nextBugHold(null, v, 'video', error, im.reason || 'config', T0, 'build-a'), ...extra };
    return { row: { status: 'failed', error, output_summary: { [BH.BUG_HOLD_KEY]: hold } }, v, hold };
  };

  await check('U1 youtube_blocked_auth → pausa inmediata de la regla youtube_auth; mensaje y acción de reconexión (nunca «no tienes que hacer nada»)', async () => {
    const { v, hold } = heldRow(YT_ERR);
    eq([v.rule, BH.holdsImmediately(v).hold], ['youtube_auth', true], 'regla');
    assert(BH.needsYoutubeReconnect(hold), 'pide reconexión');
    eq(BH.bugHoldMessageOf(hold), BH.YOUTUBE_RECONNECT_MESSAGE, 'mensaje');
    assert(/Vuelve a conectarlo/.test(BH.YOUTUBE_RECONNECT_MESSAGE) && !/No tienes que hacer nada/.test(BH.YOUTUBE_RECONNECT_MESSAGE), 'texto');
    const other = heldRow(UNK).hold;
    eq([BH.needsYoutubeReconnect(other), BH.bugHoldMessageOf(other)], [false, BH.CURSIA_ISSUE_MESSAGE], 'otra pausa: mensaje de siempre');
  });

  await check('U2 sin reconexión → waiting_youtube_reconnect; conexión ANTERIOR a la pausa → sigue esperando', async () => {
    const { row, v } = heldRow(YT_ERR);
    const ctx = { now: at(30), buildId: 'build-a', verdict: v, itemType: 'video' };
    eq(BH.bugHoldResumeDecision(row, ctx), { resume: false, reason: 'waiting_youtube_reconnect' }, 'sin conexión');
    eq(BH.bugHoldResumeDecision(row, { ...ctx, youtubeConnectedAt: at(-60).toISOString() }), { resume: false, reason: 'waiting_youtube_reconnect' }, 'conexión vieja');
  });

  await check('U3 reconexión posterior → youtube_reconnected; vale aunque el tope automático esté usado y en enfriamiento; no cuenta en el tope', async () => {
    const { row, v } = heldRow(YT_ERR, { autoResumes: 3, lastResumeAt: at(-1).toISOString() });
    const d = BH.bugHoldResumeDecision(row, { now: at(30), buildId: 'build-a', verdict: v, itemType: 'video', youtubeConnectedAt: at(10).toISOString() });
    eq([d.resume, d.trigger], [true, 'youtube_reconnected'], JSON.stringify(d));
    const after = BH.resumedBugHold(row.output_summary[BH.BUG_HOLD_KEY], at(30), 'system', 'youtube_reconnected');
    eq([after.active, after.autoResumes, after.resumeTrigger], [false, 3, 'youtube_reconnected'], 'fuera del tope');
  });

  await check('U4 pago incierto → nunca por reconexión; una pausa que NO es de YouTube no se reanuda por una reconexión', async () => {
    const a = heldRow(YT_ERR, { paidUncertain: true });
    eq(BH.bugHoldResumeDecision(a.row, { now: at(30), buildId: 'build-a', verdict: a.v, itemType: 'video', youtubeConnectedAt: at(10).toISOString() }),
      { resume: false, reason: 'paid_uncertain' }, 'pago incierto');
    const b = heldRow(UNK);
    const d = BH.bugHoldResumeDecision(b.row, { now: at(30), buildId: 'build-a', verdict: b.v, itemType: 'video', youtubeConnectedAt: at(10).toISOString() });
    eq(d, { resume: false, reason: 'still_unmapped' }, 'otra pausa');
  });

  await check('U5 tras reanudar y volver a fallar igual, la pausa nueva (heldAt nuevo) espera OTRA reconexión', async () => {
    const { row, v, hold } = heldRow(YT_ERR);
    const resumed = BH.resumedBugHold(hold, at(30), 'system', 'youtube_reconnected');
    const again = BH.nextBugHold(resumed, v, 'video', YT_ERR, 'config', at(40), 'build-a');
    const r2 = { ...row, output_summary: { [BH.BUG_HOLD_KEY]: again } };
    eq(BH.bugHoldResumeDecision(r2, { now: at(50), buildId: 'build-a', verdict: v, itemType: 'video', youtubeConnectedAt: at(10).toISOString() }),
      { resume: false, reason: 'waiting_youtube_reconnect' }, 'misma reconexión no vale dos veces');
    const d = BH.bugHoldResumeDecision(r2, { now: at(70), buildId: 'build-a', verdict: v, itemType: 'video', youtubeConnectedAt: at(60).toISOString() });
    eq(d.trigger, 'youtube_reconnected', 'reconexión nueva');
  });

  await check('U6 (review 1) youtube_publisher_not_configured es configuración de Cursia: mensaje de siempre, nunca se reanuda por reconexión', async () => {
    const { row, v, hold } = heldRow('youtube_publisher_not_configured: sin publicador');
    eq([v.rule, hold.code], ['youtube_auth', 'youtube_publisher_not_configured'], 'regla');
    eq([BH.needsYoutubeReconnect(hold), BH.bugHoldMessageOf(hold)], [false, BH.CURSIA_ISSUE_MESSAGE], 'mensaje');
    const d = BH.bugHoldResumeDecision(row, { now: at(30), buildId: 'build-a', verdict: v, itemType: 'video', youtubeConnectedAt: at(10).toISOString() });
    assert(!(d.resume && d.trigger === 'youtube_reconnected'), JSON.stringify(d));
  });

  await check('U7 (review 2) reconexión ENTRE el fallo y la escritura de la pausa (barrido ≥ 15 min / backfill) → se reanuda', async () => {
    const v = verdictOf(YT_ERR);
    const hold = BH.nextBugHold(null, v, 'video', YT_ERR, 'config', T0, 'build-a', at(-20));
    const row = { status: 'failed', error: YT_ERR, output_summary: { [BH.BUG_HOLD_KEY]: hold } };
    const d = BH.bugHoldResumeDecision(row, { now: at(5), buildId: 'build-a', verdict: v, itemType: 'video', youtubeConnectedAt: at(-10).toISOString() });
    eq([d.resume, d.trigger], [true, 'youtube_reconnected'], JSON.stringify(d));
    eq(BH.bugHoldResumeDecision(row, { now: at(5), buildId: 'build-a', verdict: v, itemType: 'video', youtubeConnectedAt: at(-30).toISOString() }),
      { resume: false, reason: 'waiting_youtube_reconnect' }, 'conexión anterior al fallo: no');
  });

  // ═══ PG: Postgres 16 real ═══════════════════════════════════════════════════
  if (NO_PG) console.log('   (--no-pg: se omite la parte con Postgres)');
  else {
    const { setupR95Db, MOCK_CTX } = require('./lib/r95-db');
    const IT = L('modules/dynamic-generation/item-transitions.js');
    const H = await setupR95Db('r102');
    const { ds, runs } = H;
    const OWNER = '22222222-3333-4444-8555-666666666102';
    const prevSince = process.env.R99_BUG_HOLD_SINCE;
    process.env.R99_BUG_HOLD_SINCE = '2000-01-01T00:00:00Z';
    try {
      await H.setBudget(OWNER, 500);
      const C = await H.makeCourse(OWNER, 'Curso r102', 'o102@cliente.test');
      const runId = (await runs.startRun(C.cid, OWNER, 1, MOCK_CTX)).run.id;
      const items = await ds.query(`select id, item_key, type from public.generation_item_runs where job_id = $1 order by item_key`, [runId]);
      const target = items.find((r) => r.type === 'video') || items.find((r) => r.type === 'content');
      assert(target, 'hay una parte');
      const rowOf = async (id) => (await ds.query(`select * from public.generation_item_runs where id = $1`, [id]))[0];
      const ledgerCount = async () => Number((await ds.query(`select count(*)::int as n from public.generation_cost_events where run_id = $1`, [runId]))[0].n);
      const spend0 = await ledgerCount();
      const failTx = async (id, error) => {
        await ds.query(`update public.generation_item_runs set status = 'running', attempt_count = attempt_count + 1, lease_until = now() + interval '5 min', worker_id = 'w-r102' where id = $1`, [id]);
        const qr = ds.createQueryRunner(); await qr.connect(); await qr.startTransaction();
        try {
          await qr.query(`select id from public.production_jobs where id = $1 for update`, [runId]);
          const t = await IT.applyItemFailure(qr, id, error, false, null, false, false, { source: 'server_worker' });
          await IT.recomputeRunStatus(qr, runId);
          await qr.commitTransaction();
          return t;
        } catch (e) { await qr.rollbackTransaction(); throw e; } finally { await qr.release(); }
      };

      await check('PG1 sin la tabla youtube_connections: el barrido no se rompe (sin reconexiones)', async () => {
        await failTx(target.id, YT_ERR);
        const r = await rowOf(target.id);
        eq([r.status, r.output_summary.bugHold && r.output_summary.bugHold.active, r.output_summary.bugHold.rule], ['failed', true, 'youtube_auth'], 'pausa');
        const s = await runs.sweepCursiaIssues({ buildId: r.output_summary.bugHold.buildId });
        assert(s.skipped.some((x) => x.itemKey === target.item_key && x.reason === 'waiting_youtube_reconnect'), JSON.stringify(s));
      });

      await check('PG2 DTO: la parte y el run piden reconectar YouTube (mensaje + acción reconnect_youtube)', async () => {
        const dto = await runs.getRun(C.cid, OWNER, 1, runId);
        const it = dto.items.find((x) => x.itemKey === target.item_key);
        eq([it.recovery.cursiaIssue.message, it.recovery.cursiaIssue.action], [BH.YOUTUBE_RECONNECT_MESSAGE, 'reconnect_youtube'], 'parte');
        eq([dto.completion.cursiaIssue.message, dto.completion.cursiaIssue.action], [BH.YOUTUBE_RECONNECT_MESSAGE, 'reconnect_youtube'], 'run');
        assert(dto.completion.complete !== true, 'nunca «Curso listo»');
      });

      // Mismo tipo que la entidad (timestamp SIN zona): se escribe y se lee con un Date de Node, como TypeORM.
      await ds.query(`create table public.youtube_connections (id uuid primary key default gen_random_uuid(), user_id uuid not null unique,
                        status varchar(50) not null default 'active', connected_at timestamp not null default now())`);
      const r0 = await rowOf(target.id);
      const heldAt = Date.parse(r0.output_summary.bugHold.heldAt);
      const buildId = r0.output_summary.bugHold.buildId;

      await check('PG3 conexión ANTERIOR a la pausa, o reconexión con el canal en reauth_required → sigue en pausa', async () => {
        await ds.query(`insert into public.youtube_connections (user_id, status, connected_at) values ($1, 'active', $2)`, [OWNER, new Date(heldAt - 3600_000)]);
        let s = await runs.sweepCursiaIssues({ buildId });
        assert(s.skipped.some((x) => x.itemKey === target.item_key && x.reason === 'waiting_youtube_reconnect'), 'vieja: ' + JSON.stringify(s));
        await ds.query(`update public.youtube_connections set status = 'reauth_required', connected_at = $2 where user_id = $1`, [OWNER, new Date()]);
        s = await runs.sweepCursiaIssues({ buildId });
        assert(s.skipped.some((x) => x.itemKey === target.item_key && x.reason === 'waiting_youtube_reconnect'), 'no activa: ' + JSON.stringify(s));
        eq((await rowOf(target.id)).status, 'failed', 'sigue en pausa');
      });

      await check('PG4 el creador reconecta (conexión activa posterior) → el barrido la reabre vía retryItem (pending, youtube_reconnected); sin gasto', async () => {
        // Reconexión real (reloj de ahora, posterior a la pausa): nunca una fecha futura que tape la pausa siguiente.
        await new Promise((r) => setTimeout(r, 20));
        await ds.query(`update public.youtube_connections set status = 'active', connected_at = $2 where user_id = $1`, [OWNER, new Date()]);
        const s = await runs.sweepCursiaIssues({ buildId });
        assert(s.resumed.some((x) => x.itemKey === target.item_key && x.trigger === 'youtube_reconnected'), JSON.stringify(s));
        const r = await rowOf(target.id);
        eq([r.status, r.output_summary.bugHold.active, r.output_summary.bugHold.resumeTrigger], ['pending', false, 'youtube_reconnected'], 'reabierta');
        eq(await ledgerCount(), spend0, 'sin gasto');
      });

      await check('PG4b (review 3) otra parte del mismo run en pausa por un bug de Cursia → el run muestra el mensaje de siempre (reconectar solo no termina el curso)', async () => {
        const other = items.find((r) => r.id !== target.id && r.type === 'content') || items.find((r) => r.id !== target.id);
        await failTx(other.id, UNK);
        await ds.query(`update public.generation_item_runs set status = 'pending', attempt_count = max_attempts - 1 where id = $1`, [other.id]);
        await failTx(other.id, UNK);
        await failTx(target.id, YT_ERR);
        const dto = await runs.getRun(C.cid, OWNER, 1, runId);
        const ci = dto.completion.cursiaIssue;
        assert(ci && ci.items.length >= 2, JSON.stringify(ci));
        eq([ci.message, ci.action], [BH.CURSIA_ISSUE_MESSAGE, undefined], 'run');
        const it = dto.items.find((x) => x.itemKey === target.item_key);
        eq(it.recovery.cursiaIssue.action, 'reconnect_youtube', 'la parte sí pide reconectar');
        // deja la parte de YouTube como antes de PG5 (reabierta) para seguir el flujo
        await ds.query(`update public.generation_item_runs set status = 'pending', error = null where id = $1`, [target.id]);
      });

      await check('PG5 vuelve a fallar igual → pausa nueva; la MISMA reconexión no la reabre otra vez', async () => {
        await new Promise((r) => setTimeout(r, 20));
        await failTx(target.id, YT_ERR);
        const r = await rowOf(target.id);
        eq([r.status, r.output_summary.bugHold.active], ['failed', true], 'pausa de nuevo');
        const s = await runs.sweepCursiaIssues({ buildId });
        assert(s.skipped.some((x) => x.itemKey === target.item_key && x.reason === 'waiting_youtube_reconnect'), JSON.stringify(s));
      });
    } finally {
      if (prevSince === undefined) delete process.env.R99_BUG_HOLD_SINCE; else process.env.R99_BUG_HOLD_SINCE = prevSince;
      await H.close();
    }
  }

  console.log(`\n${failures === 0 ? '✅' : '❌'} r102 YouTube reconnect: ${passes} ok, ${failures} fallos`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
