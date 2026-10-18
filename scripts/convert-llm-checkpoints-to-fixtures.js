#!/usr/bin/env node
/* eslint-disable */
// r58 (I1) — CONVERSOR offline: salida JSON de llm-diagnostics (GET admin/dynamic-runs/:runId/items/:itemKey/llm-diagnostics:
// claim + checkpoints con su texto) → archivo de fixtures de replay v1 (scripts/lib/replay-api.js). Mismo hash de pedido
// que el worker: un checkpoint pagado pasa a ser una fixture sin volver a llamar a nadie. NO lee la base ni Storage
// ni la red: solo el archivo que se le pasa. Sanea claves, tokens, correos y el dueño de las rutas.
//
// Uso: node scripts/convert-llm-checkpoints-to-fixtures.js <diagnostics.json> <out.json> [--synthetic] [--model=<id>]
//        [--contract=<promptVersion>] [--validator=<versión>]
//   Sin --synthetic la fixture se marca synthetic:false (respuesta real) y NUNCA se acepta dentro del repo
//   (scripts/fixtures/replay/): las respuestas reales de un curso no se versionan.
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./lib/replay-api');

const REPO_FIXTURES = path.resolve(__dirname, 'fixtures', 'replay');

function convertFile(inFile, outFile, o = {}) {
  const diag = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const { fixtures, skipped } = R.fixturesFromDiagnostics(diag, { synthetic: o.synthetic === true, model: o.model ?? null, contractVersion: o.contract ?? null, validatorVersion: o.validator ?? null });
  const doc = R.fixtureDoc(fixtures, { comment: `Convertido desde llm-diagnostics (${o.synthetic ? 'muestra sintética' : 'respuestas REALES: no versionar'}).` });
  const absOut = path.resolve(outFile);
  if (!doc.synthetic && (absOut + path.sep).startsWith(REPO_FIXTURES + path.sep)) {
    throw new Error(`REAL_FIXTURE_IN_REPO: ${outFile} está dentro de scripts/fixtures/replay/ y las fixtures no son sintéticas; usá una ruta fuera del repo`);
  }
  fs.writeFileSync(absOut, JSON.stringify(doc, null, 1) + '\n');
  return { fixtures: fixtures.length, skipped, synthetic: doc.synthetic, out: absOut };
}

module.exports = { convertFile };

if (require.main === module) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const opt = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  if (pos.length !== 2) { console.error('uso: convert-llm-checkpoints-to-fixtures.js <diagnostics.json> <out.json> [--synthetic] [--model=…] [--contract=…] [--validator=…]'); process.exit(2); }
  try {
    const r = convertFile(pos[0], pos[1], { synthetic: args.includes('--synthetic'), model: opt('model'), contract: opt('contract'), validator: opt('validator') });
    console.log(`${r.fixtures} fixture(s) → ${r.out} (synthetic=${r.synthetic}); omitidos: ${r.skipped.length}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
