#!/usr/bin/env node
/* eslint-disable */
// r63 (SC) — reparto justo, topes de concurrencia y admisión del scheduler, contra Postgres 16 REAL (desechable), 0 red.
//
//   [F1] sin configuración: el claim global es el FIFO de siempre (cada claim = la consulta de referencia FIFO
//        `order by g.created_at, posición en el Manifest, id`), sin config errors ni admisión
//   [F2] owner_rr: round-robin entre DUEÑOS, FIFO dentro de cada dueño (el dueño chico no espera al grande)
//   [F3] run_rr: round-robin entre RUNS
//   [F4] topes por tipo / proveedor: nunca más partes running que el tope, también con 3 «procesos» (3 DataSource) y
//        30 claims en paralelo; al liberar, entra la siguiente; un tope de otro tipo no frena al resto
//   [F5] admisión (flag): con tope 2 solo 2 runs empiezan; el 3.º espera (`admission_queued` para el navegador, el
//        worker no lo mira) y entra cuando uno termina; 3 procesos en paralelo nunca admiten más de 2; tope por dueño;
//        un run pausado libera su lugar
//   [F6] configuración inválida → se ignora (comportamiento de siempre) y queda en configErrors
//   [F7] RR + lease vencida: el barrido la devuelve, se re-reclama con previousError=lease_expired (Q-21) y el
//        dependiente sigue esperando a su dependencia (dependencias respetadas)
//   [F8] métricas de cola (solo lectura): profundidad / espera por tipo, admisión y posición en cola, uso de topes;
//        la transacción READ ONLY rechaza escrituras
//   [F9] DYNAMIC_PROVIDER_WORKER_CONCURRENCY: sin definir = 1 (serial de siempre), 1..4, inválido = error al arrancar
//
// Usage: npm run build && node scripts/check-r63-fair-scheduler.js
'use strict';
const path = require('path');
require('reflect-metadata');
const realFetch = global.fetch;
global.fetch = async (u, o) => { if (String(u).startsWith('data:')) return realFetch(u, o); throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };
const { Logger } = require('@nestjs/common');
const LOGS = [];
Logger.overrideLogger({ log: () => {}, warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)), debug: () => {}, verbose: () => {} });
const B = require('./e2e/lib/r63-sim-pg');
const FS = B.L('modules/dynamic-generation/fair-scheduling.js');
const QM = B.L('modules/dynamic-generation/scheduler-queue-metrics.js');
const PW = B.L('workers/dynamic-provider-worker.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (err) { failures++; console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };

const OA = '11111111-2222-4333-8444-555555555555';
const OB = '22222222-3333-4444-8555-666666666666';
const OC = '33333333-4444-4555-8666-777777777777';
const SCHED_ENV = ['DYNAMIC_SCHEDULER_POLICY', 'DYNAMIC_SCHEDULER_TYPE_CAPS', 'DYNAMIC_SCHEDULER_PROVIDER_CAPS', 'DYNAMIC_ADMISSION_ENABLED',
  'DYNAMIC_ADMISSION_MAX_ACTIVE_RUNS', 'DYNAMIC_ADMISSION_MAX_ACTIVE_PER_OWNER'];
function setSched(vars) { for (const k of SCHED_ENV) delete process.env[k]; Object.assign(process.env, vars || {}); }

(async () => {
  let env = null;
  try {
    env = await B.startSimPg({ log: () => {} });
    const { ds, sched } = env;
    const ALL = [...B.L('modules/generation-manifests/generation-manifest-builder.js').ALL_MANIFEST_ITEM_TYPES];
    let n = 0;
    const closeAll = () => ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed' where execution_mode = 'dynamic_generation' and worker_status <> 'completed'`);
    const mk = async (ownerId, chapters = 2) => B.createCourseRun(env, { ownerId, title: `F${++n}`, chapters });
    /** Deja reclamables los items de `types` completando (SQL) todo lo que va antes en el DAG del curso sintético. */
    const prereqsDone = (runIds, types) => ds.query(
      `update public.generation_item_runs set status = 'completed', finished_at = now() where job_id = any($1::uuid[]) and type = any($2::text[])`,
      [runIds, types]);
    const label = (runs, it) => `${runs.findIndex((r) => r.runId === it.runId)}:${it.type}:${it.chapterNumber ?? '-'}`;
    const fifoRef = async (types) => (await ds.query(
      `select g.id from public.generation_item_runs g
         join public.production_jobs pj on pj.id = g.job_id
         join public.course_generation_manifests m on m.id = g.manifest_id
         left join lateral (select e.ord from jsonb_array_elements(m.manifest_json->'items') with ordinality as e(it, ord) where e.it->>'key' = g.item_key limit 1) mo on true
        where pj.execution_mode = 'dynamic_generation' and pj.worker_status in ('queued', 'running', 'retrying')
          and ${B.L('modules/dynamic-generation/scheduler.service.js').claimablePredicate('g', '$1')}
        order by g.created_at, mo.ord nulls last, g.id limit 1`, [types]))[0];

    await check('[F1] sin configuración = FIFO de siempre (cada claim coincide con la consulta de referencia), sin errores de config', async () => {
      setSched({});
      const cfg = FS.fairSchedulingConfig();
      eq([cfg.policy, cfg.caps, cfg.admission, cfg.errors], ['fifo', [], { enabled: false }, []], 'defaults');
      eq(FS.candidateOrderBy('fifo'), 'order by g.created_at, mo.ord nulls last, g.id', 'ORDER BY idéntico al de siempre');
      eq(FS.lastServedSql('fifo', '$1', '$4'), { with: '', joins: '' }, 'sin CTE ni joins');
      await closeAll();
      const runs = [await mk(OA), await mk(OA), await mk(OB)];
      await prereqsDone(runs.map((r) => r.runId), ['course_plan', 'course_intro', 'module_intro']);
      const seq = [];
      for (let i = 0; i < 40; i++) {
        const ref = await fifoRef(ALL);
        const it = await sched.claimNextItem({ executorId: 'f1', types: ALL, leaseSeconds: 60 });
        if (!it) { assert(!ref, 'la referencia tenía candidato y el claim no'); break; }
        eq(it.itemRunId, ref && ref.id, `claim ${i}: mismo item que FIFO`);
        seq.push(label(runs, it));
        await B.simCompleteItem(ds, it.itemRunId, 'f1');
      }
      assert(seq.length === 3 * 13, `todas las partes (${seq.length})`);
      assert(seq.slice(0, 13).every((s) => s.startsWith('0:')), `FIFO: el run 0 entero primero (${seq.slice(0, 14).join(' ')})`);
    });

    await check('[F2] owner_rr: alterna dueños, FIFO dentro del dueño', async () => {
      await closeAll();
      setSched({ DYNAMIC_SCHEDULER_POLICY: 'owner_rr' });
      const runs = [await mk(OA), await mk(OA), await mk(OB)];
      await prereqsDone(runs.map((r) => r.runId), ['course_plan', 'course_intro', 'module_intro']);
      const seq = [];
      for (let i = 0; i < 6; i++) {
        const it = await sched.claimNextItem({ executorId: 'f2', types: ['content'], leaseSeconds: 60 });
        assert(it, `claim ${i}`);
        seq.push(label(runs, it));
      }
      eq(seq, ['0:content:1', '2:content:1', '0:content:2', '2:content:2', '1:content:1', '1:content:2'], 'orden owner_rr');
    });

    await check('[F3] run_rr: alterna runs', async () => {
      await closeAll();
      setSched({ DYNAMIC_SCHEDULER_POLICY: 'run_rr' });
      const runs = [await mk(OA), await mk(OA), await mk(OB)];
      await prereqsDone(runs.map((r) => r.runId), ['course_plan', 'course_intro', 'module_intro']);
      const seq = [];
      for (let i = 0; i < 6; i++) {
        const it = await sched.claimNextItem({ executorId: 'f3', types: ['content'], leaseSeconds: 60 });
        assert(it, `claim ${i}`);
        seq.push(label(runs, it));
      }
      eq(seq, ['0:content:1', '1:content:1', '2:content:1', '0:content:2', '1:content:2', '2:content:2'], 'orden run_rr');
    });

    await check('[F4] topes por tipo / proveedor: nunca se superan (3 procesos × 10 claims en paralelo); al liberar entra otra; otros tipos siguen', async () => {
      await closeAll();
      setSched({ DYNAMIC_SCHEDULER_POLICY: 'owner_rr', DYNAMIC_SCHEDULER_TYPE_CAPS: 'video=2', DYNAMIC_SCHEDULER_PROVIDER_CAPS: 'gamma=1' });
      const runs = [await mk(OA), await mk(OB), await mk(OC)];
      await prereqsDone(runs.map((r) => r.runId), ['course_plan', 'course_intro', 'module_intro', 'content']);
      const procs = [await env.proc(2), await env.proc(2), await env.proc(2)];
      const got = await Promise.all(Array.from({ length: 30 }, (_, i) => procs[i % 3].sched.claimNextItem({ executorId: `f4-${i}`, types: ['video', 'presentation'], leaseSeconds: 60 })
        .then((it) => (it ? { ...it, executorId: `f4-${i}` } : null))));
      const claimed = got.filter(Boolean);
      const byType = (t) => claimed.filter((x) => x.type === t).length;
      eq([byType('video'), byType('presentation')], [2, 1], 'video ≤ 2, presentation (gamma) ≤ 1');
      const [db] = await ds.query(`select count(*) filter (where type = 'video')::int v, count(*) filter (where type = 'presentation')::int p from public.generation_item_runs where status = 'running'`);
      eq([db.v, db.p], [2, 1], 'running en la DB');
      assert(!(await sched.claimNextItem({ executorId: 'f4-x', types: ['video', 'presentation'], leaseSeconds: 60 })), 'lleno → null');
      const other = await sched.claimNextItem({ executorId: 'f4-o', types: ['experience'], leaseSeconds: 60 });
      assert(other && other.type === 'experience', 'otro tipo sin tope sigue');
      const v = claimed.find((x) => x.type === 'video');
      assert(await B.simCompleteItem(ds, v.itemRunId, v.executorId), 'complete video');
      const nxt = await sched.claimNextItem({ executorId: 'f4-y', types: ['video'], leaseSeconds: 60 });
      assert(nxt && nxt.type === 'video', 'liberado → entra otro video');
      const m = await QM.computeSchedulerQueueMetrics(ds);
      const cap = (k) => m.caps.find((c) => c.key === k);
      eq([cap('type:video').running, cap('type:video').max, cap('provider:gamma').running], [2, 2, 1], 'métricas de topes');
    });

    await check('[F5] admisión: tope 2 global (3 procesos en paralelo), cola visible, entra al terminar otro; tope por dueño; pausado libera', async () => {
      await closeAll();
      setSched({ DYNAMIC_ADMISSION_ENABLED: 'true', DYNAMIC_ADMISSION_MAX_ACTIVE_RUNS: '2' });
      const runs = [await mk(OA), await mk(OB), await mk(OC)];
      const procs = [await env.proc(2), await env.proc(2), await env.proc(2)];
      const got = (await Promise.all(Array.from({ length: 12 }, (_, i) => procs[i % 3].sched.claimNextItem({ executorId: `f5-${i}`, types: ALL, leaseSeconds: 60 })))).filter(Boolean);
      const started = await ds.query(`select id from public.production_jobs where id = any($1::uuid[]) and worker_status in ('running', 'retrying')`, [runs.map((r) => r.runId)]);
      eq(started.length, 2, 'exactamente 2 runs admitidos');
      assert(new Set(got.map((g) => g.runId)).size === 2, 'claims solo de los admitidos');
      const waiting = runs.find((r) => !started.some((s) => s.id === r.runId));
      const br = await sched.claimNextItemDetailed({ runId: waiting.runId, ownerId: waiting.ownerId, executorId: 'f5-browser', types: ['course_plan', 'content', 'experience'], leaseSeconds: 60,
        executorFeatures: ['pedagogy-brief-1', 'application-activity-1', 'guided-practice-1'] });
      eq([br.item, br.reason], [null, 'admission_queued'], 'navegador del run en cola');
      const [lease] = await ds.query(`select executor_lease_holder from public.production_jobs where id = $1`, [waiting.runId]);
      eq(lease.executor_lease_holder, null, 'esperar admisión no toma el lease de ejecución');
      let m = await QM.computeSchedulerQueueMetrics(ds);
      const wq = m.runs.find((r) => r.runId === waiting.runId);
      eq([wq.admission, wq.queuePosition, m.totals.admittedRuns, m.totals.queuedRuns], ['queued', 1, 2, 1], 'métricas: en cola, posición 1');
      // Termina uno de los admitidos → el que esperaba entra.
      const first = runs.find((r) => started.some((s) => s.id === r.runId));
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed' where id = $1`, [first.runId]);
      const it = await sched.claimNextItem({ executorId: 'f5-z', types: ALL, leaseSeconds: 60 });
      assert(it && it.runId === waiting.runId, `entra el que esperaba (${it && it.runId})`);
      // Pausado libera: se pausa el otro admitido → un run nuevo puede entrar.
      const other = runs.find((r) => r.runId !== first.runId && r.runId !== waiting.runId);
      await ds.query(`update public.production_jobs set worker_status = 'paused' where id = $1`, [other.runId]);
      const fresh = await mk(OA);
      const it2 = await sched.claimNextItem({ executorId: 'f5-w', types: ['course_plan'], leaseSeconds: 60 });
      assert(it2 && it2.runId === fresh.runId, 'pausado libera su lugar');
      // Tope por dueño: OA ya tiene 1 admitido (fresh) → otro run de OA espera aunque haya lugar global.
      await closeAll();
      setSched({ DYNAMIC_ADMISSION_ENABLED: 'true', DYNAMIC_ADMISSION_MAX_ACTIVE_RUNS: '5', DYNAMIC_ADMISSION_MAX_ACTIVE_PER_OWNER: '1' });
      const a1 = await mk(OA); const a2 = await mk(OA); const b1 = await mk(OB);
      const owners = [];
      for (let i = 0; i < 4; i++) { const x = await sched.claimNextItem({ executorId: `f5-o${i}`, types: ['course_plan'], leaseSeconds: 60 }); if (x) owners.push(x.runId); }
      eq(owners.sort(), [a1.runId, b1.runId].sort(), 'un run por dueño');
      m = await QM.computeSchedulerQueueMetrics(ds);
      eq(m.runs.find((r) => r.runId === a2.runId).admission, 'queued', 'el segundo de OA en cola');
    });

    await check('[F6] configuración inválida → se ignora (comportamiento de siempre) y se informa', async () => {
      const c = FS.fairSchedulingConfig({ DYNAMIC_SCHEDULER_POLICY: 'lifo', DYNAMIC_SCHEDULER_TYPE_CAPS: 'video=0', DYNAMIC_SCHEDULER_PROVIDER_CAPS: 'gamma=2,foo=1',
        DYNAMIC_ADMISSION_ENABLED: 'true', DYNAMIC_ADMISSION_MAX_ACTIVE_RUNS: 'x' });
      eq([c.policy, c.caps.length, c.admission], ['fifo', 0, { enabled: true, maxActiveRuns: 12, maxActivePerOwner: null }], 'defaults');
      eq(c.errors.length, 4, `4 errores (${c.errors.join(' | ')})`);
      const ok = FS.fairSchedulingConfig({ DYNAMIC_SCHEDULER_PROVIDER_CAPS: 'openai_tts=2' });
      eq(ok.caps.map((x) => [x.key, x.types, x.max]), [['provider:openai_tts', ['audio_welcome', 'audiobook_chapter'], 2]], 'TTS = bienvenida + audiolibro');
      const an = FS.fairSchedulingConfig({ DYNAMIC_SCHEDULER_PROVIDER_CAPS: 'anthropic=8' });
      assert(an.caps[0].types.includes('audiobook_chapter') && an.caps[0].types.includes('content') && !an.caps[0].types.includes('video'), 'anthropic incluye el guion del audiolibro');
      await closeAll();
      setSched({ DYNAMIC_SCHEDULER_POLICY: 'lifo' });
      LOGS.length = 0;
      const r = await mk(OA);
      const it = await sched.claimNextItem({ executorId: 'f6', types: ALL, leaseSeconds: 60 });
      assert(it && it.runId === r.runId && it.type === 'course_plan', 'claim normal (fifo)');
      assert(LOGS.some((l) => /configuración ignorada .*DYNAMIC_SCHEDULER_POLICY=lifo/.test(l)), 'logger.error');
    });

    await check('[F7] RR + lease vencida: barrido → re-claim con previousError=lease_expired (Q-21); dependencias respetadas', async () => {
      await closeAll();
      setSched({ DYNAMIC_SCHEDULER_POLICY: 'owner_rr' });
      const a = await mk(OA); const b = await mk(OB);
      await prereqsDone([a.runId, b.runId], ['course_plan', 'course_intro', 'module_intro']);
      const x = await sched.claimNextItem({ executorId: 'f7-a', types: ['content'], leaseSeconds: 60 });
      assert(x && x.runId === a.runId && !x.previousError, 'claim 1');
      // El dependiente (video del capítulo) NO es reclamable mientras su content está running.
      const dep = await sched.claimNextItem({ executorId: 'f7-v', types: ['video'], leaseSeconds: 60 });
      assert(!dep, 'video espera a su content');
      await ds.query(`update public.generation_item_runs set lease_until = now() - interval '1 second' where id = $1`, [x.itemRunId]);
      const y = await sched.claimNextItem({ executorId: 'f7-b', types: ['content'], leaseSeconds: 60 });
      assert(y && y.runId === b.runId, 'B (no servido) primero');
      await ds.query(`update public.generation_item_runs set next_retry_at = now() - interval '1 second' where id = $1 and status = 'retrying'`, [x.itemRunId]);
      const seen = [];
      for (let i = 0; i < 4; i++) {
        const z = await sched.claimNextItem({ executorId: `f7-c${i}`, types: ['content'], leaseSeconds: 60 });
        if (!z) break;
        seen.push(z);
        if (z.itemRunId === x.itemRunId) break;
      }
      const again = seen.find((z) => z.itemRunId === x.itemRunId);
      assert(again, `re-claim del item vencido (${seen.map((z) => z.itemKey).join(',')})`);
      eq([again.attempt, again.previousError], [2, 'lease_expired'], 'intento 2 con previousError');
      const [row] = await ds.query(`select max_attempts, attempt_count from public.generation_item_runs where id = $1`, [x.itemRunId]);
      assert(Number(row.attempt_count) === 2, 'attempt_count 2 (el intento gratis lo maneja el barrido)');
    });

    await check('[F8] métricas de cola: profundidad, espera, admisión y READ ONLY', async () => {
      await closeAll();
      setSched({});
      const a = await mk(OA);
      const qr = ds.createQueryRunner();
      await qr.connect();
      try {
        await qr.query('start transaction read only');
        const m = await QM.computeSchedulerQueueMetrics(qr);
        eq(m.version, 'scheduler-queue-v1', 'versión');
        const cp = m.byType.find((t) => t.type === 'course_plan');
        eq([cp.pending, cp.claimable, cp.running], [1, 1, 0], 'course_plan reclamable');
        const ct = m.byType.find((t) => t.type === 'content');
        eq([ct.pending, ct.claimable], [2, 0], 'content pendiente, no reclamable (dependencia)');
        assert(typeof cp.oldestReadyWaitSec === 'number' && cp.oldestReadyWaitSec >= 0, 'espera');
        const r = m.runs.find((x) => x.runId === a.runId);
        eq([r.admission, r.items, r.completed, 'queuePosition' in r], ['queued', 16, 0, false], 'sin admisión no hay posición');
        let err = null;
        try { await qr.query(`update public.production_jobs set updated_at = now() where id = $1`, [a.runId]); } catch (e) { err = e; }
        assert(err && /read-only/.test(err.message), 'READ ONLY rechaza escrituras');
      } finally { try { await qr.query('rollback'); } catch {} await qr.release(); }
      const svc = new QM.SchedulerQueueMetricsService(ds);
      const s = await svc.snapshot();
      assert(s.totals.dispatchableRuns >= 1, 'servicio');
      const C = B.L('modules/dynamic-generation/admin-runs.controller.js').AdminDynamicRunsController;
      assert(typeof C.prototype.schedulerQueue === 'function', 'endpoint GET /admin/dynamic-runs/scheduler-queue');
      const guards = Reflect.getMetadata('__guards__', C) || [];
      eq(guards.map((g) => g.name), ['SupabaseJwtGuard', 'SuperAdminGuard'], 'SuperAdmin');
    });

    await check('[F9] DYNAMIC_PROVIDER_WORKER_CONCURRENCY: default 1, 1..4, inválido lanza', async () => {
      eq([PW.providerWorkerConcurrency({}), PW.providerWorkerConcurrency({ DYNAMIC_PROVIDER_WORKER_CONCURRENCY: '3' })], [1, 3], 'valores');
      for (const bad of ['0', '5', 'x', '2.5']) {
        let e = null;
        try { PW.providerWorkerConcurrency({ DYNAMIC_PROVIDER_WORKER_CONCURRENCY: bad }); } catch (x) { e = x; }
        assert(e && /DYNAMIC_PROVIDER_WORKER_CONCURRENCY inválido/.test(e.message), `«${bad}» lanza`);
      }
    });
  } catch (err) {
    failures++;
    console.error(`❌ setup falló: ${err && err.stack ? err.stack : err}`);
  } finally {
    setSched({});
    if (env) await env.stop();
  }
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})();
