#!/usr/bin/env node
/* eslint-disable */
// Product Hardening (Task 2): el reporte de fallos de generación (solo lectura)
// agrupa por tipo + código estable (sin ids ni texto libre), cuenta fallos
// finales y previos (reintentos manuales) y nunca escribe: la consulta es un
// único SELECT.
'use strict';
const fs = require('fs');
const path = require('path');
const F = require('./lib/failures-report');
let ok = 0, bad = 0;
function check(name, fn) { try { fn(); ok++; console.log(`✅ ${name}`); } catch (e) { bad++; console.error(`❌ ${name}\n   ${e.message}`); } }
function eq(a, b, m) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }

check('classifyError: código estable (prefijo + códigos de validación), sin ids ni texto libre', () => {
  eq(F.classifyError('experience inválido tras reintento dirigido: MOVEMENT_RANGE en $.a; QUANTITY_CLAIM; UNKNOWN_FIELD 12ab34cd-1111-2222-3333-444455556666'),
    'experience_invalid_after_retry [MOVEMENT_RANGE,QUANTITY_CLAIM,UNKNOWN_FIELD]', 'validación');
  eq(F.classifyError('provider_reconciliation_required: openai — llamada pagada enviada sin resultado liquidado. tts_failed: chunk 1/1'), 'provider_reconciliation_required', 'reconciliación');
  eq(F.classifyError('H5P_INPUT_INVALID(InteractiveVideo): title: máximo 200 caracteres'), 'H5P_INPUT_INVALID', 'h5p');
  eq(F.classifyError(''), '(sin mensaje)', 'vacío');
  eq(F.classifyError('run 12ab34cd-1111-2222-3333-444455556666 falló'), F.classifyError('run 99ab34cd-1111-2222-3333-444455556666 falló'), 'ids no separan grupos');
});

check('summarize: por tipo (fallidos, >1 intento, reintentos manuales) y grupos ordenados por frecuencia con final/previo', () => {
  const E = 'experience inválido tras reintento dirigido: MOVEMENT_RANGE';
  const s = F.summarize([
    { type: 'experience', status: 'failed', attempt_count: 3, error: E, job_id: 'r1', course_id: 1, previous_errors: [{ error: E }] },
    { type: 'experience', status: 'completed', attempt_count: 2, error: null, job_id: 'r2', course_id: 2, previous_errors: [{ error: E }] },
    { type: 'content', status: 'completed', attempt_count: 1, error: null, job_id: 'r2', course_id: 2, previous_errors: [] },
  ]);
  eq(s.byType.experience, { items: 2, completed: 1, failed: 1, blocked: 0, multiAttempt: 2, manualRetries: 2 }, 'experience');
  eq(s.byType.content.failed, 0, 'content');
  eq([s.top[0].key, s.top[0].total, s.top[0].final, s.top[0].previous, s.top[0].runs, s.top[0].courses],
    ['experience · experience_invalid_after_retry [MOVEMENT_RANGE]', 3, 1, 2, 2, 2], 'grupo');
});

check('solo lectura: la consulta del reporte es un único SELECT (sin insert/update/delete)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'lib/failures-report.js'), 'utf8');
  const sql = src.slice(src.indexOf('await c.query('), src.indexOf('params,', src.indexOf('await c.query(')));
  if (!/select/i.test(sql) || /\b(insert|update|delete|truncate|alter|drop)\b/i.test(sql)) throw new Error('la consulta debe ser solo SELECT');
  if ((src.match(/c\.query\(/g) || []).length !== 1) throw new Error('una sola consulta');
});

console.log(`\n${ok} ok, ${bad} fail`);
process.exit(bad ? 1 : 0);
