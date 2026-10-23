#!/usr/bin/env node
/* eslint-disable */
// r58 (I1) — GRABA las fixtures SINTÉTICAS de replay (scripts/fixtures/replay/) corriendo el driver offline en modo
// record con el LLM FALSO del E2E (nunca un proveedor real: Fase A). Mismo hash de pedido que el worker. Re-grabar cuando
// cambian los prompts del ejecutor (check-replay.js lo avisa con REPLAY_FIXTURE_MISSING).
//
// Uso: node scripts/record-replay-fixtures.js [--check]   (requiere `npm run build`; --check: no escribe, falla si difiere)
'use strict';
require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const D = require('./lib/offline-driver');
const R = require('./lib/replay-api');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/offline-driver/course.json'), 'utf8'));
/** Cada set: nombre de archivo + selección del driver (lo grabado incluye las dependencias del sub-DAG). */
const SETS = [
  { file: 'od1-activity-m0c0.json', select: [{ type: 'activity', chapter: { m: 0, c: 0 } }], comment: 'Una actividad H5P (capítulo 1.1) con sus dependencias (course_plan, content).' },
];

(async () => {
  const check = process.argv.includes('--check');
  let diff = 0;
  for (const s of SETS) {
    const r = await D.runComponents(DIST, CFG, { select: s.select, llm: { mode: 'record' } });
    if (!r.ok) throw new Error(`${s.file}: la corrida de grabación falló: ${JSON.stringify(r.errors.slice(0, 3))}`);
    const doc = R.fixtureDoc(r.llm.recorded, { comment: `SINTÉTICO (LLM falso del E2E, sin proveedor real). ${s.comment} Regenerar con scripts/record-replay-fixtures.js.` });
    if (!doc.synthetic) throw new Error(`${s.file}: una fixture no es sintética`);
    const out = path.join(__dirname, 'fixtures/replay', s.file);
    const text = JSON.stringify(doc, null, 1) + '\n';
    if (check) {
      const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
      if (cur !== text) { diff++; console.log(`❌ ${s.file} desactualizada (re-grabar)`); } else console.log(`✅ ${s.file} al día (${doc.fixtures.length} fixtures)`);
    } else {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text);
      console.log(`grabado ${path.relative(ROOT, out)} (${doc.fixtures.length} fixtures)`);
    }
  }
  process.exit(diff ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
