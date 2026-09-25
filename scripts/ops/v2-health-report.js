#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════════
// v2-health-report.js — reporte de salud de Cursia V2 (estructura dinámica),
// SOLO LECTURA, para correr a mano o por cron durante el rollout (Fase 9).
//
// Lee production_jobs / generation_item_runs / artifacts / usage_events /
// cost_rates y reporta:
//   1. items dynamic FALLIDOS en las últimas 24 h, por type y error;
//   2. leases vencidos (items y jobs dynamic en 'running' con lease_until
//      pasado + margen);
//   3. fallos de dynamic_package en 24 h (+ runs con >1 job de empaquetado
//      activo — señal del gap M9 de audit-track0);
//   4. runs dynamic_generation activos hace más de N horas;
//   5. gasto REAL de Videogen (output_summary.costUsd de items video en modo
//      real) 24 h / 7 d vs. estimación con la tarifa activa de cost_rates;
//   6. bytes en Storage de artifacts dynamic (item_run_id/manifest_id no nulo).
//
// Nunca escribe: la sesión se pone en `default_transaction_read_only = on` y
// todas las consultas corren dentro de `begin transaction read only` +
// rollback. Nunca lee .env implícitamente (solo --env-file <ruta> explícito,
// que SOLO aporta claves de conexión DB_*: umbrales V2_HEALTH_* y el ref
// esperado deben venir del entorno real o de la CLI — fix wave I1). Los
// textos de error se redactan (JWT, tokens, URLs, emails — M4). Umbrales
// fraccionarios permitidos (M7).
//
// Código de salida: 0 = OK, 2 = algún umbral superado (sirve para alertar
// desde cron), 1 = error (no se pudo conectar, etc.), 3 = objetivo rechazado.
//
// Umbrales (env, con defaults):
//   V2_HEALTH_MAX_FAILED_ITEMS_24H     5
//   V2_HEALTH_LEASE_GRACE_MINUTES      10
//   V2_HEALTH_MAX_STUCK_LEASES         0
//   V2_HEALTH_MAX_PACKAGE_FAILURES_24H 0
//   V2_HEALTH_LONG_RUN_HOURS           6
//   V2_HEALTH_MAX_LONG_RUNS            0
//   V2_HEALTH_MAX_VIDEOGEN_USD_24H     25
//   V2_HEALTH_MAX_VIDEOGEN_USD_7D      100
//   V2_HEALTH_MAX_SPEND_RATIO_7D       1.5   (real / estimado; solo si hay tarifa)
//   V2_HEALTH_MAX_DYNAMIC_STORAGE_GB   20
// "Superado" = valor > máximo.
//
// Objetivo: --expect-ref <ref> (o V2_HEALTH_EXPECTED_REF) obliga a que el ref
// de Supabase parseado de DB_HOST/DB_USER coincida (recomendado en cron).
// Uso: ver docs/v2-production-migrations.md §Observabilidad.
// ══════════════════════════════════════════════════════════════════════════

const target = require('../lib/v2-production-target');

const THRESHOLD_DEFAULTS = {
  V2_HEALTH_MAX_FAILED_ITEMS_24H: 5,
  V2_HEALTH_LEASE_GRACE_MINUTES: 10,
  V2_HEALTH_MAX_STUCK_LEASES: 0,
  V2_HEALTH_MAX_PACKAGE_FAILURES_24H: 0,
  V2_HEALTH_LONG_RUN_HOURS: 6,
  V2_HEALTH_MAX_LONG_RUNS: 0,
  V2_HEALTH_MAX_VIDEOGEN_USD_24H: 25,
  V2_HEALTH_MAX_VIDEOGEN_USD_7D: 100,
  V2_HEALTH_MAX_SPEND_RATIO_7D: 1.5,
  V2_HEALTH_MAX_DYNAMIC_STORAGE_GB: 20,
};

function readThresholds(env) {
  const out = {};
  for (const [k, def] of Object.entries(THRESHOLD_DEFAULTS)) {
    const raw = env[k];
    if (raw === undefined || raw === '') { out[k] = def; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k}=${JSON.stringify(raw)} no es un número >= 0`);
    out[k] = n;
  }
  return out;
}

function parseArgs(argv) {
  const a = { json: false, envFile: null, expectRef: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--env-file') a.envFile = argv[++i];
    else if (x === '--expect-ref') a.expectRef = argv[++i];
    else if (x === '--help' || x === '-h') a.help = true;
    else throw new Error(`argumento desconocido: ${x}`);
  }
  return a;
}

async function tableExists(client, qualified) {
  const { rows } = await client.query('select to_regclass($1) is not null as ok', [qualified]);
  return rows[0].ok === true;
}

async function collect(client, th) {
  const report = { generatedAt: new Date().toISOString(), metrics: {}, notes: [] };
  const has = {
    gir: await tableExists(client, 'public.generation_item_runs'),
    pj: await tableExists(client, 'public.production_jobs'),
    art: await tableExists(client, 'public.artifacts'),
    ue: await tableExists(client, 'public.usage_events'),
    cr: await tableExists(client, 'public.cost_rates'),
  };
  let artHasItemRun = false;
  if (has.art) {
    const { rows } = await client.query(
      `select count(*)::int as n from information_schema.columns
        where table_schema='public' and table_name='artifacts' and column_name in ('item_run_id','manifest_id')`,
    );
    artHasItemRun = rows[0].n === 2;
  }
  if (!has.gir) report.notes.push('generation_item_runs no existe (¿migraciones V2 no aplicadas?) — métricas de items en n/a');

  // 1. Items fallidos 24 h
  if (has.gir) {
    const { rows } = await client.query(
      `select type,
              left(regexp_replace(coalesce(error, '(sin error)'), '[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}', '…', 'gi'), 100) as error,
              count(*)::int as n
         from public.generation_item_runs
        where status = 'failed' and coalesce(finished_at, updated_at) >= now() - interval '24 hours'
        group by 1, 2 order by n desc, type limit 50`,
    );
    // M4: redactar y reagrupar (dos errores que solo difieren en un token
    // quedan en el mismo grupo).
    const grouped = new Map();
    for (const r of rows) {
      const error = target.redactSensitive(r.error);
      const k = r.type + '\u0000' + error;
      const prev = grouped.get(k);
      if (prev) prev.n += r.n; else grouped.set(k, { type: r.type, error, n: r.n });
    }
    const breakdown = [...grouped.values()].sort((a, b) => b.n - a.n || a.type.localeCompare(b.type));
    const total = breakdown.reduce((a, r) => a + r.n, 0);
    report.metrics.failedItems24h = { value: total, max: th.V2_HEALTH_MAX_FAILED_ITEMS_24H, breakdown };
  }

  // 2. Leases vencidos
  {
    const grace = th.V2_HEALTH_LEASE_GRACE_MINUTES;
    let items = [];
    let jobs = [];
    if (has.gir) {
      ({ rows: items } = await client.query(
        `select id, job_id, item_key, type, worker_id, lease_until,
                round(extract(epoch from (now() - lease_until)) / 60)::int as expired_minutes
           from public.generation_item_runs
          where status = 'running' and lease_until is not null
            and lease_until < now() - make_interval(secs => $1::float8 * 60)
          order by lease_until limit 50`,
        [grace],
      ));
    }
    if (has.pj) {
      ({ rows: jobs } = await client.query(
        `select id, execution_mode, worker_id, lease_until,
                round(extract(epoch from (now() - lease_until)) / 60)::int as expired_minutes
           from public.production_jobs
          where execution_mode in ('dynamic_generation','dynamic_package')
            and worker_status = 'running' and lease_until is not null
            and lease_until < now() - make_interval(secs => $1::float8 * 60)
          order by lease_until limit 50`,
        [grace],
      ));
    }
    report.metrics.stuckLeases = {
      value: items.length + jobs.length, max: th.V2_HEALTH_MAX_STUCK_LEASES, graceMinutes: grace, items, jobs,
    };
  }

  // 3. dynamic_package: fallos 24 h + jobs activos duplicados por run
  if (has.pj) {
    const { rows: failures } = await client.query(
      `select id, input_payload->>'runId' as run_id, left(coalesce(error_message, ''), 160) as error, updated_at
         from public.production_jobs
        where execution_mode = 'dynamic_package'
          and (worker_status in ('failed','failed_recoverable','failed_retryable') or status = 'failed')
          and updated_at >= now() - interval '24 hours'
        order by updated_at desc limit 50`,
    );
    const { rows: dup } = await client.query(
      `select input_payload->>'runId' as run_id, count(*)::int as active_jobs
         from public.production_jobs
        where execution_mode = 'dynamic_package' and worker_status in ('queued','running','retrying')
        group by 1 having count(*) > 1 order by 2 desc limit 20`,
    );
    for (const f of failures) f.error = target.redactSensitive(f.error);
    report.metrics.packageFailures24h = { value: failures.length, max: th.V2_HEALTH_MAX_PACKAGE_FAILURES_24H, failures };
    report.metrics.packageDuplicateActive = { value: dup.length, info: 'runs con >1 dynamic_package activo (gap M9) — informativo', runs: dup };
  }

  // 4. Runs activos hace más de N horas
  if (has.pj) {
    const { rows } = await client.query(
      `select id, worker_status, input_payload->>'manifestId' as manifest_id, created_at,
              round(extract(epoch from (now() - created_at)) / 3600, 1)::float as hours
         from public.production_jobs
        where execution_mode = 'dynamic_generation' and worker_status in ('queued','running','retrying')
          and created_at < now() - make_interval(secs => $1::float8 * 3600)
        order by created_at limit 50`,
      [th.V2_HEALTH_LONG_RUN_HOURS],
    );
    report.metrics.longRunningRuns = { value: rows.length, max: th.V2_HEALTH_MAX_LONG_RUNS, hours: th.V2_HEALTH_LONG_RUN_HOURS, runs: rows };
  }

  // 5. Gasto real de Videogen vs estimación
  if (has.gir) {
    const { rows } = await client.query(
      `with v as (
         select coalesce(finished_at, updated_at) as ts,
                case when (output_summary->>'costUsd') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                     then (output_summary->>'costUsd')::numeric end as cost
           from public.generation_item_runs
          where type = 'video' and output_summary->>'mode' = 'real'
            and coalesce(finished_at, updated_at) >= now() - interval '7 days'
       )
       select count(*) filter (where ts >= now() - interval '24 hours')::int as videos_24h,
              count(*)::int as videos_7d,
              coalesce(sum(cost) filter (where ts >= now() - interval '24 hours'), 0)::float as usd_24h,
              coalesce(sum(cost), 0)::float as usd_7d,
              count(*) filter (where cost is null)::int as without_cost_7d
         from v`,
    );
    let rate = null;
    if (has.cr) {
      const r = await client.query(
        `select rate_usd::float as rate_usd from public.cost_rates
          where provider = 'video_engine' and service = 'video_generation' and unit_type = 'per_video'
            and is_active = true and model is null
          order by id desc limit 1`,
      );
      rate = r.rows[0] ? r.rows[0].rate_usd : null;
    }
    const s = rows[0];
    const est7d = rate === null ? null : s.videos_7d * rate;
    const ratio = est7d && est7d > 0 ? s.usd_7d / est7d : null;
    report.metrics.videogenSpend = {
      usd24h: s.usd_24h, usd7d: s.usd_7d, videos24h: s.videos_24h, videos7d: s.videos_7d,
      withoutCost7d: s.without_cost_7d, ratePerVideoUsd: rate, estimated7dUsd: est7d, ratio7d: ratio,
      max24h: th.V2_HEALTH_MAX_VIDEOGEN_USD_24H, max7d: th.V2_HEALTH_MAX_VIDEOGEN_USD_7D, maxRatio7d: th.V2_HEALTH_MAX_SPEND_RATIO_7D,
    };
    if (rate === null) report.notes.push('sin tarifa activa video_engine/video_generation/per_video en cost_rates — no hay estimación contra la cual comparar');
    if (s.without_cost_7d > 0) report.notes.push(`${s.without_cost_7d} video(s) real(es) en 7 d sin costUsd (getVideoCost falló) — el gasto real está SUBESTIMADO`);
  }
  let ueCols = 0;
  if (has.ue) {
    const { rows } = await client.query(
      `select count(*)::int as n from information_schema.columns
        where table_schema='public' and table_name='usage_events' and column_name in ('component','cost_type','real_cost_usd')`,
    );
    ueCols = rows[0].n;
    if (ueCols !== 3) report.notes.push('usage_events sin columnas component/cost_type/real_cost_usd — se omite el gasto legacy');
  }
  if (has.ue && ueCols === 3) {
    const { rows } = await client.query(
      `select coalesce(sum(real_cost_usd) filter (where created_at >= now() - interval '24 hours'), 0)::float as usd_24h,
              coalesce(sum(real_cost_usd), 0)::float as usd_7d
         from public.usage_events
        where component = 'video' and cost_type = 'real' and created_at >= now() - interval '7 days'`,
    );
    report.metrics.usageEventsVideoRealSpend = { info: 'usage_events component=video cost_type=real (flujo legacy) — informativo', ...rows[0] };
  }

  // 6. Storage de artifacts dynamic
  if (has.art && artHasItemRun) {
    const { rows } = await client.query(
      `select count(*)::int as artifacts,
              coalesce(sum(size_bytes), 0)::float as bytes,
              coalesce(sum(size_bytes) filter (where created_at >= now() - interval '24 hours'), 0)::float as bytes_24h,
              count(*) filter (where size_bytes is null)::int as without_size
         from public.artifacts
        where item_run_id is not null or manifest_id is not null`,
    );
    const { rows: byType } = await client.query(
      `select type, count(*)::int as n, coalesce(sum(size_bytes), 0)::float as bytes
         from public.artifacts where item_run_id is not null or manifest_id is not null
        group by type order by bytes desc limit 20`,
    );
    const r = rows[0];
    report.metrics.dynamicStorage = {
      artifacts: r.artifacts, bytes: r.bytes, gb: r.bytes / 1024 ** 3, bytes24h: r.bytes_24h,
      withoutSize: r.without_size, maxGb: th.V2_HEALTH_MAX_DYNAMIC_STORAGE_GB, byType,
    };
  }

  // Evaluación de umbrales
  const alerts = [];
  const m = report.metrics;
  if (m.failedItems24h && m.failedItems24h.value > m.failedItems24h.max) alerts.push(`items fallidos 24h = ${m.failedItems24h.value} > ${m.failedItems24h.max}`);
  if (m.stuckLeases && m.stuckLeases.value > m.stuckLeases.max) alerts.push(`leases vencidos = ${m.stuckLeases.value} > ${m.stuckLeases.max}`);
  if (m.packageFailures24h && m.packageFailures24h.value > m.packageFailures24h.max) alerts.push(`fallos dynamic_package 24h = ${m.packageFailures24h.value} > ${m.packageFailures24h.max}`);
  if (m.longRunningRuns && m.longRunningRuns.value > m.longRunningRuns.max) alerts.push(`runs activos > ${m.longRunningRuns.hours}h = ${m.longRunningRuns.value} > ${m.longRunningRuns.max}`);
  if (m.videogenSpend) {
    const v = m.videogenSpend;
    if (v.usd24h > v.max24h) alerts.push(`gasto Videogen 24h = $${v.usd24h.toFixed(2)} > $${v.max24h}`);
    if (v.usd7d > v.max7d) alerts.push(`gasto Videogen 7d = $${v.usd7d.toFixed(2)} > $${v.max7d}`);
    if (v.ratio7d !== null && v.ratio7d > v.maxRatio7d) alerts.push(`gasto real/estimado 7d = ${v.ratio7d.toFixed(2)} > ${v.maxRatio7d}`);
  }
  if (m.dynamicStorage && m.dynamicStorage.gb > m.dynamicStorage.maxGb) alerts.push(`Storage dynamic = ${m.dynamicStorage.gb.toFixed(2)} GB > ${m.dynamicStorage.maxGb} GB`);
  report.alerts = alerts;
  report.status = alerts.length ? 'ALERT' : 'OK';
  return report;
}

function printHuman(report, targetDesc) {
  const m = report.metrics;
  const line = (ok, s) => console.log(`${ok ? '✅' : '🚨'} ${s}`);
  console.log(`Cursia V2 health report — ${report.generatedAt} — objetivo: ${targetDesc}`);
  if (m.failedItems24h) {
    line(m.failedItems24h.value <= m.failedItems24h.max, `items fallidos 24h: ${m.failedItems24h.value} (máx ${m.failedItems24h.max})`);
    for (const b of m.failedItems24h.breakdown) console.log(`     ${b.n} × [${b.type}] ${b.error}`);
  }
  if (m.stuckLeases) {
    line(m.stuckLeases.value <= m.stuckLeases.max, `leases vencidos (> ${m.stuckLeases.graceMinutes} min): ${m.stuckLeases.value} (máx ${m.stuckLeases.max})`);
    for (const i of m.stuckLeases.items) console.log(`     item ${i.item_key} [${i.type}] run ${i.job_id} — vencido hace ${i.expired_minutes} min`);
    for (const j of m.stuckLeases.jobs) console.log(`     job ${j.id} [${j.execution_mode}] — vencido hace ${j.expired_minutes} min`);
  }
  if (m.packageFailures24h) {
    line(m.packageFailures24h.value <= m.packageFailures24h.max, `fallos dynamic_package 24h: ${m.packageFailures24h.value} (máx ${m.packageFailures24h.max})`);
    for (const f of m.packageFailures24h.failures) console.log(`     job ${f.id} run ${f.run_id}: ${f.error}`);
    if (m.packageDuplicateActive.value) console.log(`     ⚠️  ${m.packageDuplicateActive.value} run(s) con >1 empaquetado activo (M9)`);
  }
  if (m.longRunningRuns) {
    line(m.longRunningRuns.value <= m.longRunningRuns.max, `runs activos > ${m.longRunningRuns.hours} h: ${m.longRunningRuns.value} (máx ${m.longRunningRuns.max})`);
    for (const r of m.longRunningRuns.runs) console.log(`     run ${r.id} [${r.worker_status}] manifest ${r.manifest_id} — ${r.hours} h`);
  }
  if (m.videogenSpend) {
    const v = m.videogenSpend;
    const ok = v.usd24h <= v.max24h && v.usd7d <= v.max7d && (v.ratio7d === null || v.ratio7d <= v.maxRatio7d);
    line(ok, `Videogen real: 24h $${v.usd24h.toFixed(2)} (${v.videos24h} videos, máx $${v.max24h}) · 7d $${v.usd7d.toFixed(2)} (${v.videos7d} videos, máx $${v.max7d})` +
      ` · estimado 7d ${v.estimated7dUsd === null ? 'n/a' : '$' + v.estimated7dUsd.toFixed(2)}` +
      ` · ratio ${v.ratio7d === null ? 'n/a' : v.ratio7d.toFixed(2)} (máx ${v.maxRatio7d})`);
  }
  if (m.usageEventsVideoRealSpend) {
    const u = m.usageEventsVideoRealSpend;
    console.log(`ℹ️  usage_events video real (legacy): 24h $${u.usd_24h.toFixed(2)} · 7d $${u.usd_7d.toFixed(2)}`);
  }
  if (m.dynamicStorage) {
    const d = m.dynamicStorage;
    line(d.gb <= d.maxGb, `Storage artifacts dynamic: ${d.artifacts} artifacts, ${d.gb.toFixed(3)} GB (máx ${d.maxGb} GB), +${(d.bytes24h / 1024 ** 2).toFixed(1)} MB en 24h${d.withoutSize ? `, ${d.withoutSize} sin size_bytes` : ''}`);
    for (const t of d.byType) console.log(`     ${t.type}: ${t.n} · ${(t.bytes / 1024 ** 2).toFixed(1)} MB`);
  }
  for (const n of report.notes) console.log(`ℹ️  ${n}`);
  console.log(report.status === 'OK' ? 'ESTADO: OK' : `ESTADO: ALERT — ${report.alerts.join(' | ')}`);
}

async function main() {
  let args;
  let th;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('node scripts/ops/v2-health-report.js [--json] [--expect-ref <ref>] [--env-file <ruta>]');
      return 0;
    }
    if (args.envFile) {
      const res = target.loadDbEnvFile(args.envFile);
      const ign = target.describeIgnoredEnvFileKeys(res.ignored);
      if (ign) console.error(ign);
    }
    th = readThresholds(process.env);
  } catch (err) {
    console.error('❌ ' + err.message);
    return 1;
  }

  const parsed = target.parseProjectRef(process.env);
  const expectRef = (args.expectRef || process.env.V2_HEALTH_EXPECTED_REF || '').toLowerCase() || null;
  if (parsed.conflict) {
    console.error(`❌ DB_HOST (${parsed.conflict.fromHost}) y DB_USER (${parsed.conflict.fromUser}) apuntan a proyectos distintos`);
    return 3;
  }
  if (expectRef && parsed.ref !== expectRef) {
    console.error(`❌ ref esperado ${expectRef} pero la conexión apunta a ${parsed.ref || '(no Supabase)'} — no se conecta`);
    return 3;
  }
  let targetDesc = parsed.ref || `${process.env.DB_HOST || '127.0.0.1'} (no Supabase)`;
  if (parsed.ref === target.KNOWN_PRODUCTION_SUPABASE_REF) targetDesc += ' [PRODUCCIÓN]';
  else if (parsed.ref === target.KNOWN_STAGING_SUPABASE_REF) targetDesc += ' [staging]';

  if (process.env.V2_DB_SSL_CA && !require('fs').existsSync(process.env.V2_DB_SSL_CA)) {
    console.error(`❌ V2_DB_SSL_CA apunta a un archivo inexistente (${process.env.V2_DB_SSL_CA})`);
    return 3;
  }
  const warn = target.tlsWarning(process.env);
  if (warn) console.error(warn);
  const { Client } = require('pg');
  const client = new Client(target.pgClientConfigFromEnv(process.env));
  try {
    await client.connect();
  } catch (err) {
    console.error('❌ No se pudo conectar:', target.redactSensitive(err.message));
    return 1;
  }
  let report;
  try {
    await target.beginReadOnlyTransaction(client);
    try {
      report = await collect(client, th);
    } finally {
      await client.query('rollback');
    }
  } catch (err) {
    console.error('❌ Error consultando:', target.redactSensitive(err.message));
    return 1;
  } finally {
    await client.end();
  }
  report.target = targetDesc;
  report.thresholds = th;
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printHuman(report, targetDesc);
  return report.status === 'OK' ? 0 : 2;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error('❌ Error inesperado:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = { collect, readThresholds, THRESHOLD_DEFAULTS };
