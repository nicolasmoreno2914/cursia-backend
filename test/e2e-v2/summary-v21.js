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

if (v2) add('E2E v2 (rulesVersion 2, runs A/B/Y, DN-1, gating)', v2.assertions, v2.aborted ? `ABORT: ${v2.aborted}` : '');
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
console.log(line('Área', '✅', '❌', 'nota'));
console.log(`|${'-'.repeat(w[0] + 2)}|${'-'.repeat(w[1] + 2)}|${'-'.repeat(w[2] + 2)}|------`);
let tp = 0; let tf = 0;
for (const r of rows) { console.log(line(...r)); tp += r[1]; tf += r[2]; }
console.log(line('TOTAL', tp, tf, ''));

console.log('\nMBZ (sha256):');
if (v2) for (const [k, a] of Object.entries(v2.artifacts || {})) console.log(`  v2 ${k.padEnd(22)} ${a.sha256}  ${a.bytes} B`);
if (v3) for (const [k, a] of Object.entries(v3.mbz || {})) console.log(`  v3 ${k.padEnd(22)} ${a.sha256}  ${a.bytes} B  (builder ${a.summary && a.summary.builderVersion})`);
console.log('\nWarnings de restore en Moodle 4.5:');
if (v2) {
  const w2 = v2.assertions.filter((a) => /precheck con 0 warnings|precheck sin warnings/.test(a.msg));
  console.log(`  v2: ${w2.length} restores, ${w2.filter((a) => !a.ok).length} con warnings`);
}
if (v3) for (const [k, m] of Object.entries(v3.moodle || {})) console.log(`  v3 ${k.padEnd(10)} curso #${m.courseid}: ${m.warnings} warnings (precheck + log del controller + backup_logs + CLI)`);
console.log('\nContadores de proveedores (fase v3):');
if (v3 && v3.counters) {
  const c = v3.counters;
  console.log(`  llamadas a proveedores REALES: ${c.realProviderCalls} (netguard bloqueó ${c.netguardBlocked}; Gamma ${c.gammaRealCalls}, TTS ${c.ttsRealCalls}, Anthropic ${c.anthropicRealCalls}, Videogen ${c.videogenRealCalls}, YouTube ${c.youtubeRealCalls})`);
  console.log(`  fakes locales: Videogen ${c.fakeVideogenSubmissions} envíos, Google ${c.fakeGoogleUploads} subidas / ${c.fakeGoogleCalls} llamadas, LLM ${c.fakeLlmCalls} llamadas`);
  console.log(`  LLM inválido 1 vez por tipo: ${JSON.stringify(c.fakeLlmInvalidFirst)} → reintentos: ${JSON.stringify(c.fakeLlmRetriesSeen)}`);
}
if (v3 && v3.finops) console.log(`  ledger v3 (proveedor/fuente/operación): ${JSON.stringify(v3.finops.ledgerV3)}`);
if (qa) console.log(`\nforceclean al terminar: ${qa.forcecleanRestored}`);
console.log(`\nRESULTADO: ${tf === 0 ? 'PASS' : 'FAIL'} — ${tp} aserciones OK, ${tf} fallidas`);
