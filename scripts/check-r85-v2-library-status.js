#!/usr/bin/env node
/* eslint-disable */
// r85 — `v2LatestRun` en GET /courses (v2-latest-run.ts) — sin DB ni red, con los módulos COMPILADOS de dist/.
//
// Verifica que:
//  1. el resumen del último run deriva bien status / completionState / packageReady (solo un paquete FINAL
//     completado con artifact cuenta; vista previa / sin artifact / run cancelado no);
//  2. todo el listado se resuelve con UNA consulta (sin N+1) y solo para cursos dynamic;
//  3. curso dynamic sin run → `v2LatestRun: null`; legacy → sin el campo; consulta caída → listado intacto;
//  4. CoursesService.findAll y findAllForInstitution lo agregan, sin tocar `courses.status`.
//
// Usage: npm run build && node scripts/check-r85-v2-library-status.js [path/to/dist]

const path = require('path');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const { summarizeV2LatestRun, attachV2LatestRuns, V2_LATEST_RUN_SQL } = require(path.join(distRoot, 'modules/courses/v2-latest-run'));
const { CoursesService } = require(path.join(distRoot, 'modules/courses/courses.service'));

let failed = 0;
function ok(cond, name, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
}

const FINAL = { inputKind: 'final', kind: 'final', artifactId: 'art-1' };
const run = (o) => ({ course_id: 91, id: 'f6b846e7-ef24-45fd-8757-b686709d105c', status: 'completed', worker_status: 'completed', finished_at: '2026-11-02T10:00:00.000Z', packages: [], ...o });

console.log('1. summarizeV2LatestRun');
{
  const s = summarizeV2LatestRun(run({ packages: [FINAL] }));
  ok(s.runId === 'f6b846e7-ef24-45fd-8757-b686709d105c' && s.status === 'completed' && s.completionState === 'complete' && s.packageReady === true && s.finishedAt === '2026-11-02T10:00:00.000Z',
    'run completado + paquete final → complete / packageReady', s);
  const legacyKind = summarizeV2LatestRun(run({ packages: [{ artifactId: 'a' }] }));
  ok(legacyKind.packageReady === true, 'paquete sin packageKind (viejo) y sin señales de vista previa → final', legacyKind);
  const asText = summarizeV2LatestRun(run({ packages: JSON.stringify([FINAL]) }));
  ok(asText.packageReady === true, 'packages como texto JSON también se lee', asText);
  const qa = summarizeV2LatestRun(run({ packages: [{ inputKind: 'qa_preview', kind: 'qa_preview', artifactId: 'a' }] }));
  ok(qa.packageReady === false && qa.completionState === 'packaging', 'solo paquete qa_preview → no listo (packaging)', qa);
  const mock = summarizeV2LatestRun(run({ packages: [{ artifactId: 'a', mockProviderItems: 3 }] }));
  ok(mock.packageReady === false, 'paquete viejo con proveedores simulados → no listo', mock);
  const pend = summarizeV2LatestRun(run({ packages: [{ artifactId: 'a', pendingVideos: ['v1'] }] }));
  ok(pend.packageReady === false, 'paquete viejo con videos pendientes → no listo', pend);
  const noArt = summarizeV2LatestRun(run({ packages: [{ inputKind: 'final', kind: 'final', artifactId: null }] }));
  ok(noArt.packageReady === false, 'paquete final sin artifact → no listo', noArt);
  const running = summarizeV2LatestRun(run({ status: 'running', worker_status: 'running', finished_at: null }));
  ok(running.completionState === 'in_progress' && running.status === 'running' && running.finishedAt === null, 'running → in_progress', running);
  for (const ws of ['queued', 'retrying']) {
    const r = summarizeV2LatestRun(run({ status: ws, worker_status: ws, finished_at: null }));
    ok(r.completionState === 'in_progress', `${ws} → in_progress`, r);
  }
  const paused = summarizeV2LatestRun(run({ status: 'paused', worker_status: 'paused', finished_at: null }));
  ok(paused.completionState === 'paused' && paused.status === 'paused', 'paused → paused', paused);
  const cancelled = summarizeV2LatestRun(run({ status: 'cancelled', worker_status: 'completed', packages: [FINAL] }));
  ok(cancelled.completionState === 'cancelled' && cancelled.status === 'cancelled' && cancelled.packageReady === false, 'cancelado nunca es listo', cancelled);
  const preview = summarizeV2LatestRun(run({ status: 'preview', worker_status: 'preview' }));
  ok(preview.completionState === 'preview' && !preview.packageReady, 'preview → preview', preview);
  const failedRun = summarizeV2LatestRun(run({ status: 'failed', worker_status: 'failed' }));
  ok(failedRun.completionState === 'needs_attention' && !failedRun.packageReady, 'failed → needs_attention', failedRun);
}

console.log('2. SQL');
ok(/distinct on \(pj\.course_id\)/.test(V2_LATEST_RUN_SQL) && /order by pj\.course_id, pj\.created_at desc, pj\.id desc/.test(V2_LATEST_RUN_SQL),
  'último run por curso (distinct on + created_at desc)');
ok(/execution_mode = 'dynamic_generation'/.test(V2_LATEST_RUN_SQL) && /execution_mode = 'dynamic_package'/.test(V2_LATEST_RUN_SQL) && /worker_status = 'completed'/.test(V2_LATEST_RUN_SQL),
  'solo runs dynamic_generation y paquetes dynamic_package completados');
ok(/course_id = any\(\$1::int\[\]\)/.test(V2_LATEST_RUN_SQL), 'filtra por los ids del listado');
ok(!/\b(update|insert|delete)\b/i.test(V2_LATEST_RUN_SQL), 'solo lectura');

function fakeQ(rows, opts = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (opts.throws) throw new Error('relation does not exist');
      return rows;
    },
  };
}

(async () => {
  console.log('3. attachV2LatestRuns');
  {
    const q = fakeQ([run({ course_id: 91, packages: [FINAL] }), run({ course_id: 92, id: 'r-92', status: 'running', worker_status: 'running', finished_at: null })]);
    const courses = [
      { id: 91, structureVersion: 'dynamic', status: 'draft' },
      { id: 92, structureVersion: 'dynamic', status: 'draft' },
      { id: 93, structureVersion: 'dynamic', status: 'draft' },
      { id: 10, structureVersion: 'legacy', status: 'draft' },
    ];
    const out = await attachV2LatestRuns(q, courses);
    ok(q.calls.length === 1, 'UNA consulta para todo el listado', q.calls.length);
    ok(JSON.stringify(q.calls[0].params) === JSON.stringify([[91, 92, 93]]), 'parámetros: solo ids dynamic', q.calls[0].params);
    ok(out === courses, 'devuelve el mismo arreglo');
    ok(out[0].v2LatestRun && out[0].v2LatestRun.packageReady === true && out[0].v2LatestRun.completionState === 'complete', 'curso 91 → listo', out[0].v2LatestRun);
    ok(out[1].v2LatestRun && out[1].v2LatestRun.completionState === 'in_progress', 'curso 92 → generando', out[1].v2LatestRun);
    ok(out[2].v2LatestRun === null, 'dynamic sin run → null');
    ok(!('v2LatestRun' in out[3]), 'legacy → sin el campo');
    ok(out.every((c) => c.status === 'draft'), 'courses.status no cambia');
  }
  {
    const q = fakeQ([]);
    await attachV2LatestRuns(q, [{ id: 1, structureVersion: 'legacy' }]);
    ok(q.calls.length === 0, 'sin cursos dynamic → ninguna consulta');
  }
  {
    const q = fakeQ([], { throws: true });
    const warns = [];
    const courses = [{ id: 91, structureVersion: 'dynamic' }];
    const out = await attachV2LatestRuns(q, courses, { warn: (m) => warns.push(m) });
    ok(out.length === 1 && !('v2LatestRun' in out[0]) && warns.length === 1, 'consulta caída → listado intacto, sin el campo, con aviso', { out, warns });
  }

  console.log('4. CoursesService');
  {
    for (const method of ['findAll', 'findAllForInstitution']) {
      const listed = [
        { id: 91, structureVersion: 'dynamic', status: 'draft', metadata: { documentRequirements: { big: true }, courseId: 'uuid-91' } },
        { id: 10, structureVersion: 'legacy', status: 'draft', metadata: {} },
      ];
      const qb = { orderBy() { return qb; }, where() { return qb; }, async getMany() { return listed; } };
      const calls = [];
      const repo = {
        createQueryBuilder() { return qb; },
        async query(sql, params) { calls.push({ sql, params }); return [run({ course_id: 91, packages: [FINAL] })]; },
      };
      const svc = new CoursesService(repo, {});
      const out = await svc[method](method === 'findAll' ? 'owner-1' : 'inst-1');
      ok(calls.length === 1 && out[0].v2LatestRun && out[0].v2LatestRun.packageReady === true && !('v2LatestRun' in out[1]),
        `${method} agrega v2LatestRun (1 consulta)`, { calls: calls.length, v2: out[0].v2LatestRun });
      ok(out[0].status === 'draft' && out[0].metadata.courseId === 'uuid-91' && out[0].metadata.documentRequirements === undefined,
        `${method} conserva status y el recorte de metadata`, out[0]);
    }
  }

  console.log(failed ? `\n${failed} FAILED` : '\nALL OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
