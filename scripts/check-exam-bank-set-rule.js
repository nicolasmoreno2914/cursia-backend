#!/usr/bin/env node
/* eslint-disable */
// Banco de examen — regla de CONJUNTO (≤ 30 % «la correcta es la más larga»), 2026-10-15 (examen final #1353, intento 3):
// el worker conserva los puntos de guardado SOLO cuando el ejecutor devuelve un borrador reintentable con
// keepCheckpoints (banco con todas las hojas completas que solo falla esa regla); cualquier otra falla los descarta.
// Uso: npm run build && node scripts/check-exam-bank-set-rule.js
'use strict';
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');
const W = require(path.join(REPO, 'dist/workers/dynamic-llm-worker.js'));
let pass = 0; let fail = 0;
function ok(c, m, d) { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m + (d !== undefined ? '  ' + JSON.stringify(d) : '')); } }
const draft = { type: 'dynamic_exam_bank_draft_json', content: '{}', filename: 'd.json', mimeType: 'application/json' };
const D = W.discardCheckpointsOnFailure;
ok(typeof D === 'function', 'discardCheckpointsOnFailure exportada');
ok(D({ ok: false, retryable: true, draft, keepCheckpoints: true }) === false, 'regla de conjunto (borrador reintentable + keepCheckpoints) → se CONSERVAN');
ok(D({ ok: false, retryable: true, draft }) === true, 'borrador sin keepCheckpoints (hoja bajo el piso) → se descartan, como siempre');
ok(D({ ok: false, retryable: true, keepCheckpoints: true }) === true, 'keepCheckpoints sin borrador → se descartan (no hay qué reanudar)');
ok(D({ ok: false, retryable: false, draft, keepCheckpoints: true }) === true, 'falla definitiva → se descartan');
ok(D({ ok: false, retryable: true, draft, keepCheckpoints: 'true' }) === true, 'solo el booleano true cuenta');
ok(D(null) === true && D(undefined) === true, 'sin resultado → se descartan');
// El worker usa el helper (no un borrado incondicional).
const src = fs.readFileSync(path.join(REPO, 'src/workers/dynamic-llm-worker.ts'), 'utf8');
ok(/if \(!draftSaved \|\| discardCheckpointsOnFailure\(result\)\) \{\s*await deps\.scheduler\.recordItemExternal\(item\.itemRunId, deps\.executorId, \{ llmCheckpoints: \{\} \}\)/.test(src), 'processLlmItem conserva los puntos de guardado solo con keepCheckpoints Y borrador subido (rev. I3)');
ok(src.indexOf('const draftSaved') > src.indexOf('opts[draftField] = await uploadArtifact'), 'la decisión se toma DESPUÉS de subir el borrador');
// El ejecutor vendorizado declara la razón bank_rule y marca keepCheckpoints solo con ella.
const ex = fs.readFileSync(path.join(REPO, 'vendor/dynamic-executor/45-dynamic-generation-executor.js'), 'utf8');
ok(/var DYN_EXAM_BANK_DRAFT_REASONS = \[[^\]]*'bank_rule'\]/.test(ex), 'vendor: bank_rule es razón de borrador');
ok(/if \(reason === 'bank_rule'\) out\.keepCheckpoints = true;/.test(ex), 'vendor: keepCheckpoints solo con bank_rule');
console.log(`\n${fail ? 'HAY FALLAS' : 'Todos los checks de la regla de conjunto pasaron'} (${pass} ✅, ${fail} ❌).`);
process.exit(fail ? 1 : 0);
