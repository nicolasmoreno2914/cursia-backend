/* eslint-disable */
// r75 · Agente E — mini harness de aserciones (sin dependencias). Cada aserción lleva el ítem de la matriz (a)–(l).
'use strict';
const results = [];
let cur = '-';
function item(id) { cur = id; }
function ok(cond, msg, detail) {
  const r = { item: cur, ok: !!cond, msg };
  if (!cond && detail !== undefined) r.detail = detail;
  results.push(r);
  console.log(`${cond ? 'PASS' : 'FAIL'} [${cur}] ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 800) : ''}`);
  return !!cond;
}
function pending(msg, why) { results.push({ item: cur, ok: null, msg, pending: why }); console.log(`PEND [${cur}] ${msg} — ${why}`); }
function eq(a, b, msg) { return ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }
function summary(label) {
  const by = {};
  for (const r of results) { const b = (by[r.item] = by[r.item] || { pass: 0, fail: 0, pending: 0 }); r.ok === null ? b.pending++ : r.ok ? b.pass++ : b.fail++; }
  const fail = results.filter((r) => r.ok === false).length;
  const pend = results.filter((r) => r.ok === null).length;
  console.log(`\n== ${label}: ${results.length - fail - pend} PASS, ${fail} FAIL, ${pend} PENDIENTE ==`);
  for (const [k, b] of Object.entries(by)) console.log(`  ${k}: ${b.pass} pass / ${b.fail} fail / ${b.pending} pend`);
  return { results, by, fail, pend };
}
module.exports = { item, ok, eq, pending, summary, results };
