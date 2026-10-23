/* eslint-disable */
// Product Hardening (Task 2) — reporte de SOLO LECTURA de fallos de generación en
// staging: por tipo de item, cuántos terminaron fallidos, cuántos necesitaron más
// de un intento y cuáles son los errores más frecuentes (normalizados a un
// "código" estable), incluidos los errores previos de reintentos manuales
// (output_summary.previousErrors). Sirve para atacar causas raíz con datos, no
// síntomas. Nunca escribe ni llama a proveedores.
'use strict';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Código estable de un mensaje de error: el prefijo "CODIGO:" si existe (o
 * "tipo inválido tras reintento dirigido"), más los códigos de validación en
 * MAYÚSCULAS que aparezcan (p.ej. MOVEMENT_RANGE, QUANTITY_CLAIM). Sin ids,
 * números ni texto libre → agrupa bien.
 */
function classifyError(msg) {
  const m = String(msg || '').replace(UUID_RE, '<id>').trim();
  if (!m) return '(sin mensaje)';
  let head;
  const pre = m.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/);
  if (pre) head = pre[1];
  else if (/inválido tras reintento dirigido/i.test(m)) head = `${m.split(' ')[0]}_invalid_after_retry`;
  else head = m.split(/[:.(]/)[0].slice(0, 48).trim().replace(/\s+/g, '_');
  const codes = [...new Set((m.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || []).filter((c) => c !== head))].sort().slice(0, 4);
  return codes.length ? `${head} [${codes.join(',')}]` : head;
}

function summarize(rows) {
  const byType = {};
  const groups = new Map();
  const add = (type, msg, kind, runId, courseId) => {
    const key = `${type} · ${classifyError(msg)}`;
    const g = groups.get(key) || { key, final: 0, previous: 0, runs: new Set(), courses: new Set(), example: String(msg).replace(UUID_RE, '<id>').slice(0, 160) };
    g[kind]++;
    if (runId) g.runs.add(runId);
    if (courseId) g.courses.add(courseId);
    groups.set(key, g);
  };
  for (const r of rows) {
    const t = (byType[r.type] = byType[r.type] || { items: 0, completed: 0, failed: 0, blocked: 0, multiAttempt: 0, manualRetries: 0 });
    t.items++;
    if (r.status === 'completed') t.completed++;
    if (r.status === 'failed') t.failed++;
    if (r.status === 'blocked') t.blocked++;
    if (Number(r.attempt_count) > 1) t.multiAttempt++;
    const prev = Array.isArray(r.previous_errors) ? r.previous_errors : [];
    t.manualRetries += prev.length;
    if (r.status === 'failed' && r.error) add(r.type, r.error, 'final', r.job_id, r.course_id);
    for (const p of prev) if (p && p.error) add(r.type, p.error, 'previous', r.job_id, r.course_id);
  }
  const top = [...groups.values()]
    .map((g) => ({ ...g, total: g.final + g.previous, runs: g.runs.size, courses: g.courses.size }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  return { byType, top };
}

async function failuresReport(c, { courseId = null, days = 30 } = {}) {
  const params = [days];
  let filter = '';
  if (courseId) { params.push(courseId); filter = 'and j.course_id = $2'; }
  const { rows } = await c.query(
    `select g.type, g.status, g.attempt_count, g.error, g.job_id, j.course_id,
            case when jsonb_typeof(g.output_summary->'previousErrors') = 'array' then g.output_summary->'previousErrors' else '[]'::jsonb end as previous_errors
       from public.generation_item_runs g
       join public.production_jobs j on j.id = g.job_id
      where j.execution_mode = 'dynamic_generation' and g.created_at >= now() - make_interval(days => $1) ${filter}`,
    params,
  );
  return { rows: rows.length, ...summarize(rows) };
}

function printReport(rep, log = console.log) {
  log(`items analizados: ${rep.rows}`);
  log('por tipo: items | completados | fallidos | bloqueados | >1 intento | reintentos manuales');
  for (const [t, v] of Object.entries(rep.byType).sort((a, b) => b[1].failed - a[1].failed || a[0].localeCompare(b[0]))) {
    log(`  ${t.padEnd(20)} ${String(v.items).padStart(4)} | ${String(v.completed).padStart(4)} | ${String(v.failed).padStart(3)} | ${String(v.blocked).padStart(3)} | ${String(v.multiAttempt).padStart(3)} | ${String(v.manualRetries).padStart(3)}`);
  }
  log('errores más frecuentes (final = item terminó fallido; previo = fallo antes de un reintento manual):');
  for (const g of rep.top.slice(0, 20)) {
    log(`  ${String(g.total).padStart(3)}× ${g.key}  (final ${g.final}, previo ${g.previous}; ${g.runs} run(s), ${g.courses} curso(s))`);
    log(`       ej.: ${g.example.replace(/\s+/g, ' ')}`);
  }
}

module.exports = { classifyError, summarize, failuresReport, printReport };
