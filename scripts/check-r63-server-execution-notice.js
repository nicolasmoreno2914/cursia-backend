#!/usr/bin/env node
/* eslint-disable */
// r63 (UX, hallazgo 5): `previewServerExecution` solo es true cuando el servidor ejecutará TODO el run nuevo.
// Usage: npm run build && node scripts/check-r63-server-execution-notice.js [dist]
const path = require('path');
const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const R = require(path.join(distRoot, 'modules/dynamic-generation/llm-worker-routing.js'));
let passes = 0; let failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`✅ ${name}`); }
  catch (e) { failures++; console.error(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const NOW = Date.parse('2026-10-21T12:00:00Z');
const ALL = [...R.ALL_LLM_WORKER_TYPES];
const live = (types = ALL, since = '2026-10-01T00:00:00Z') => [{ types: new Set(types), since: new Date(since) }];
const ON = { DYNAMIC_LLM_WORKER_ENABLED: 'true', DYNAMIC_PROVIDER_WORKER_ENABLED: 'true' };
const LLM_ITEMS = ['course_plan', 'content', 'exam', 'final_exam'];
const WITH_PROVIDER = [...LLM_ITEMS, 'presentation', 'audio_welcome', 'audiobook_chapter'];

check('worker vivo cubriendo todo, flags encendidos, v3 → true', () => {
  assert(R.previewServerExecution(LLM_ITEMS, 3, live(), NOW, ON) === true, 'true');
  assert(R.previewServerExecution(WITH_PROVIDER, 3, live(), NOW, ON) === true, 'true con proveedores');
});
check('hold de workers → false (aunque haya latido)', () => {
  assert(R.previewServerExecution(LLM_ITEMS, 3, live(), NOW, { ...ON, DYNAMIC_WORKERS_HOLD: 'true' }) === false, 'hold');
});
check('worker de IA apagado (flag) → false', () => {
  assert(R.previewServerExecution(LLM_ITEMS, 3, live(), NOW, {}) === false, 'sin flag');
  assert(R.previewServerExecution(LLM_ITEMS, 3, live(), NOW, { DYNAMIC_LLM_WORKER_ENABLED: 'false' }) === false, 'flag false');
});
check('sin latido vivo (worker caído) → false', () => {
  assert(R.previewServerExecution(LLM_ITEMS, 3, [], NOW, ON) === false, 'sin cobertura');
});
check('run «viejo»: el worker se activó DESPUÉS de ahora → false', () => {
  assert(R.previewServerExecution(LLM_ITEMS, 3, live(ALL, '2026-10-22T00:00:00Z'), NOW, ON) === false, 'since futuro');
});
check('Manifest anterior (rulesVersion != 3) → false', () => {
  assert(R.previewServerExecution(LLM_ITEMS, 2, live(), NOW, ON) === false, 'v2');
  assert(R.previewServerExecution(LLM_ITEMS, 1, live(), NOW, ON) === false, 'v1');
});
check('el worker no cubre todos los tipos del Manifest → false', () => {
  assert(R.previewServerExecution(LLM_ITEMS, 3, live(['content', 'exam']), NOW, ON) === false, 'parcial');
});
check('Manifest con scorm (v1/v2) → false', () => {
  assert(R.previewServerExecution([...LLM_ITEMS, 'scorm'], 3, live(), NOW, ON) === false, 'scorm');
});
check('Manifest con proveedores y worker de proveedores apagado → false; sin proveedores no importa', () => {
  const env = { DYNAMIC_LLM_WORKER_ENABLED: 'true' };
  assert(R.previewServerExecution(WITH_PROVIDER, 3, live(), NOW, env) === false, 'proveedor apagado');
  assert(R.previewServerExecution(LLM_ITEMS, 3, live(), NOW, env) === true, 'solo IA');
});
check('Manifest sin partes de IA → false (nada que prometer)', () => {
  assert(R.previewServerExecution([], 3, live(), NOW, ON) === false, 'vacío');
});
console.log(`\n${passes} ok, ${failures} fallos`);
process.exit(failures ? 1 : 0);
