/* eslint-disable */
// Cursia V2.1 — R13: tabla resumen de run-e2e-v21.sh (lee los JSON/logs de la corrida).
// Uso: node summary-v21.js <E2E_SCRATCH>
'use strict';
const fs = require('fs');
const path = require('path');
const S = process.argv[2];
const OUT = path.join(S, 'e2e-out');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const v2 = readJson(path.join(OUT, 'results.json'));
const v3 = readJson(path.join(OUT, 'v3', 'results-v3.json'));
const qa = readJson(path.join(OUT, 'v3', 'browser-qa-v3.json'));
const rows = [];
const count = (list) => ({ pass: list.filter((a) => a.ok).length, fail: list.filter((a) => !a.ok).length });
const add = (area, list, note) => { const c = count(list || []); rows.push([area, c.pass, c.fail, note || '']); };

if (v2) { add('E2E v2 (rulesVersion 2, runs A/B/Y, DN-1, gating)', v2.assertions); if (v2.aborted) rows.push(['E2E v2', 0, 1, `ABORT: ${v2.aborted}`]); }
else rows.push(['E2E v2', 0, 1, 'sin results.json']);
if (v3) {
  const by = (re) => v3.assertions.filter((a) => re.test(a.step));
  add('E2E v3: arranque + gates FinOps (E0)', by(/^v3-(0|1|2)-/));
  add('E2E v3: generación E1/E2/E3 (ejecutor real + workers)', by(/^v3-E\d-generacion$/));
  add('E2E v3: empaque v3 + re-empaque E1 (tema/nota)', by(/^v3-E\d-(empaquetado|reempaque)/));
  add('E2E v3: FinOps (ledger, estimates, contadores)', by(/^v3-finops$|^v3-red-final$/));
  add('Moodle 4.5: restore + inspección + notas simuladas', by(/^moodle-/));
  if (v3.aborted) rows.push(['E2E v3', 0, 1, `ABORT: ${v3.aborted}`]);
} else rows.push(['E2E v3', 0, 1, 'sin results-v3.json']);
if (qa) {
  for (const a of [...new Set(qa.assertions.map((x) => x.area))]) add(`Navegador: ${a}`, qa.assertions.filter((x) => x.area === a));
} else rows.push(['Navegador', 0, 1, 'sin browser-qa-v3.json']);
const REG = path.join(S, 'regression');
const reg = { be: [0, 0, 0, 0], fe: [0, 0, 0, 0] };
const regFails = [];
if (fs.existsSync(REG)) {
  for (const f of fs.readdirSync(REG).filter((x) => x.endsWith('.rc'))) {
    const n = f.slice(0, -3);
    const rc = Number(fs.readFileSync(path.join(REG, f), 'utf8').trim());
    const log = fs.readFileSync(path.join(REG, `${n}.log`), 'utf8');
    const k = n.startsWith('fe-') ? 'fe' : 'be';
    reg[k][0]++; if (rc === 0) reg[k][1]++; else regFails.push(`${n} (rc=${rc})`);
    reg[k][2] += (log.match(/^\s*✅/gm) || []).length; reg[k][3] += (log.match(/^\s*❌/gm) || []).length;
  }
  rows.push([`Regresión backend (${reg.be[0]} scripts, rc=0 en ${reg.be[1]})`, reg.be[2], reg.be[3], regFails.filter((x) => !x.startsWith('fe-')).join(', ')]);
  rows.push([`Regresión frontend (${reg.fe[0]} harnesses, rc=0 en ${reg.fe[1]})`, reg.fe[2], reg.fe[3], regFails.filter((x) => x.startsWith('fe-')).join(', ')]);
}
const w = [Math.max(...rows.map((r) => String(r[0]).length), 4), 6, 6];
const line = (a, b, c, d) => `| ${String(a).padEnd(w[0])} | ${String(b).padStart(w[1])} | ${String(c).padStart(w[2])} | ${d}`;
const printTable = () => {
  console.log(line('Área', '✅', '❌', 'nota'));
  console.log(`|${'-'.repeat(w[0] + 2)}|${'-'.repeat(w[1] + 2)}|${'-'.repeat(w[2] + 2)}|------`);
  let tp = 0; let tf = 0;
  for (const r of rows) { console.log(line(...r)); tp += r[1]; tf += r[2]; }
  console.log(line('TOTAL', tp, tf, ''));
  return { tp, tf };
};

console.log('\nMBZ (sha256):');
if (v2) for (const [k, a] of Object.entries(v2.artifacts || {})) console.log(`  v2 ${k.padEnd(22)} ${a.sha256}  ${a.bytes} B`);
if (v3) for (const [k, a] of Object.entries(v3.mbz || {})) console.log(`  v3 ${k.padEnd(22)} ${a.sha256}  ${a.bytes} B  (builder ${a.summary && a.summary.builderVersion})`);
console.log('\nWarnings de restore en Moodle 4.5:');
if (v2) {
  const w2 = v2.assertions.filter((a) => /precheck con 0 warnings|precheck sin warnings/.test(a.msg));
  console.log(`  v2: ${w2.length} restores, ${w2.filter((a) => !a.ok).length} con warnings`);
}
if (v3) for (const [k, m] of Object.entries(v3.moodle || {})) console.log(`  v3 ${k.padEnd(10)} curso #${m.courseid}: ${m.warnings} warnings (precheck + log del controller + backup_logs + CLI)`);
// ── Intentos REALES a proveedores pagados: MEDIDOS en cada proceso que podía alcanzarlos ──
const PV = require('./providers');
const scopes = [
  ['E2E v2: app + workers (netguard)', PV.countNetguardLog(path.join(OUT, 'net-violations.log'))],
  ['E2E v2: ejecutor del navegador (vm)', PV.countUrls((v2 && v2.frontNet) || [])],
  ['E2E v3: app + 3 workers (netguard)', PV.countNetguardLog(path.join(OUT, 'v3', 'net-violations.log'))],
  ['E2E v3: ejecutor del navegador (vm)', PV.countUrls((v3 && v3.frontNet) || [])],
  ['Regresión: 38 checks + 25 harnesses (netguard, env limpio)', PV.countNetguardLog(path.join(S, 'regression', 'net.log'))],
  ['QA Chrome: página + iframes/workers (CDP)', qa && qa.network ? { total: qa.network.requests, byProvider: qa.network.providerRequests, otherHosts: {} } : { missing: true, byProvider: PV.emptyCounts(), total: 0 }],
];
console.log('\nIntentos REALES a proveedores pagados (medidos; 0 = ningún intento salió de 127.0.0.1 hacia su API):');
const hdr = ['alcance', ...PV.PROVIDERS, 'bloqueos totales / requests'];
console.log(`| ${hdr.join(' | ')} |`);
const tot = PV.emptyCounts();
let missing = [];
for (const [name, c] of scopes) {
  if (c.missing) missing.push(name);
  for (const k of PV.PROVIDERS) tot[k] += c.byProvider[k];
  console.log(`| ${name} | ${PV.PROVIDERS.map((k) => c.byProvider[k]).join(' | ')} | ${c.missing ? 'SIN LOG' : c.total} |`);
}
console.log(`| TOTAL | ${PV.PROVIDERS.map((k) => tot[k]).join(' | ')} | |`);
const realTotal = PV.PROVIDERS.reduce((n, k) => n + tot[k], 0);
if (realTotal !== 0 || missing.length) { rows.push(['Proveedores reales (medido)', 0, 1, `intentos=${realTotal}, sin log: ${missing.join(', ')}`]); }
const otherNg = scopes.filter(([, c]) => c.otherHosts && Object.keys(c.otherHosts).length).map(([n, c]) => `${n}: ${Object.keys(c.otherHosts).join(',')}`);
console.log(`  otros hosts bloqueados (no proveedores): ${otherNg.join(' · ') || 'ninguno'}`);
if (qa && qa.network) console.log(`  Chrome: ${qa.network.requests} requests; hosts fuera del allowlist (NOTFOUND): ${(qa.network.blockedByResolver || []).join(', ') || 'ninguno'}`);
const scrub = path.join(S, 'regression', 'scrubbed-env-names.txt');
if (fs.existsSync(scrub)) console.log(`  regresión con entorno limpio: ${fs.readFileSync(scrub, 'utf8').trim().split('\n').filter(Boolean).length} variables de credenciales/proveedores del shell no se pasaron`);
if (v3 && v3.counters) {
  const c = v3.counters;
  console.log(`  fakes locales alcanzados (v3): ${JSON.stringify(c.fakeReached)}`);
  console.log(`  LLM inválido 1 vez por tipo: ${JSON.stringify(c.fakeLlmInvalidFirst)} → reintentos: ${JSON.stringify(c.fakeLlmRetriesSeen)}`);
}
if (v3 && v3.finops) console.log(`  ledger v3 (proveedor/fuente/operación): ${JSON.stringify(v3.finops.ledgerV3)}`);
const fcFile = path.join(S, 'forceclean-final.txt');
const fcFinal = fs.existsSync(fcFile) ? fs.readFileSync(fcFile, 'utf8').trim() : null;
console.log(`\nforceclean: restaurado por el QA = ${qa && qa.forcecleanRestored}; leído al final del gate = ${fcFinal}`);
if (fcFinal !== null && fcFinal !== '0') rows.push(['forceclean final', 0, 1, fcFinal]);
console.log('\nTabla final:');
const { tp, tf } = printTable();
console.log(`\nRESULTADO: ${tf === 0 ? 'PASS' : 'FAIL'} — ${tp} aserciones OK, ${tf} fallidas`);
