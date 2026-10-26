/* eslint-disable */
// r75 · Agente E — resumen de la matriz (a)–(l) sobre las corridas por tipo de esquema; (j) = ambas corridas sin FAIL.
'use strict';
const fs = require('fs');
const path = require('path');
const [scratch, ...types] = process.argv.slice(2);
const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
const runs = types.map((ty) => { try { return JSON.parse(fs.readFileSync(path.join(scratch, `r75-out-types${ty}`, 'results.json'), 'utf8')); } catch { return { types: ty, missing: true, by: {} }; } });
const st = (b) => (!b ? 'SIN DATOS' : b.fail ? `FAIL (${b.fail}/${b.pass + b.fail})` : b.pending && !b.pass ? 'PENDIENTE' : b.pending ? `PASS parcial (${b.pass}, ${b.pending} pend.)` : `PASS (${b.pass})`);
console.log('\n══════ matriz r75 (agente E) ══════');
console.log(['ítem', ...runs.map((r) => `types=${r.types}`)].join(' | '));
let anyFail = false;
for (const it of ITEMS) {
  if (it === 'j') {
    const ok = runs.length === 2 && runs.every((r) => !r.missing && !Object.values(r.by).some((b) => b.fail));
    const ran = runs.filter((r) => !r.missing).length;
    console.log(`(j) | ${ran === 2 ? (ok ? 'PASS (0 y 1 sin fallas)' : 'FAIL (ver las otras filas)') : `PENDIENTE (${ran}/2 corridas)`}`);
    continue;
  }
  const cells = runs.map((r) => st(r.by[it]));
  if (runs.some((r) => r.by[it] && r.by[it].fail)) anyFail = true;
  console.log(`(${it}) | ${cells.join(' | ')}`);
}
const findings = runs.flatMap((r) => (r.findings || []).map((f) => ({ ...f, types: r.types })));
if (findings.length) { console.log('\nhallazgos:'); for (const f of findings) console.log(`  ${f.sev} [${f.item}] (types=${f.types}) ${f.msg}${f.repro ? `  · ${f.repro}` : ''}`); }
fs.writeFileSync(path.join(scratch, 'r75-matrix.json'), JSON.stringify({ runs: runs.map((r) => ({ types: r.types, features: r.features, by: r.by })), findings }, null, 2));
process.exit(anyFail ? 1 : 0);
