/* eslint-disable */
// r61 (F) — MODELAB · guardia de presupuesto (dura) + LEDGER persistente entre corridas (review r61 I2).
//
// - Antes de CADA llamada real se reserva su cota superior (entrada a precio de escritura de caché con holgura + max_tokens
//   de salida); si gastado (de TODAS las corridas del experimento) + reservado + cota > aprobado, la llamada NO se hace y
//   la corrida aborta con BUDGET_EXCEEDED.
// - Ledger append-only `<out>/modelab-ledger-<experimento>-<modo>.jsonl`: una línea `reserve` ANTES de llamar y una
//   `settle` después. Al arrancar, gastado previo = Σ settle.usd + Σ cota de los `reserve` sin `settle` (una caída a mitad
//   de una llamada = gasto desconocido = peor caso). El presupuesto aprobado es POR EXPERIMENTO, no por proceso.
// - Un error de red/5xx deja la cota como gasto (gasto desconocido = se asume el peor caso).
'use strict';
const fs = require('fs');
const path = require('path');

class BudgetError extends Error { constructor(code, msg, extra) { super(`${code}: ${msg}`); this.code = code; Object.assign(this, extra || {}); } }

function ledgerPath(outDir, experimentId, mode) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(experimentId))) throw new BudgetError('BUDGET_INVALID', `id de experimento inválido: ${experimentId}`);
  return path.join(outDir, `modelab-ledger-${experimentId}-${mode}.jsonl`);
}

/** Lee el ledger: gasto previo (con reservas huérfanas al peor caso). Línea ilegible = fail loud (no se adivina). */
function readLedger(file) {
  if (!fs.existsSync(file)) return { spentUsd: 0, settled: 0, orphanReserves: 0, runs: 0, lines: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const open = new Map();
  let spent = 0, settled = 0;
  const runs = new Set();
  lines.forEach((l, i) => {
    let e;
    try { e = JSON.parse(l); } catch { throw new BudgetError('BUDGET_LEDGER_CORRUPT', `${file}:${i + 1} ilegible`); }
    runs.add(e.runId);
    if (e.kind === 'reserve') open.set(`${e.runId}|${e.rid}`, e.upperUsd);
    else if (e.kind === 'settle') { open.delete(`${e.runId}|${e.rid}`); spent += Number(e.usd) || 0; settled++; }
  });
  let orphan = 0;
  for (const u of open.values()) { spent += Number(u) || 0; orphan++; }
  return { spentUsd: spent, settled, orphanReserves: orphan, runs: runs.size, lines: lines.length };
}

class BudgetGuard {
  /** o: { label, ledgerFile, runId, priorSpentUsd } — con ledgerFile, el gasto previo se lee del archivo. */
  constructor(approvedUsd, o = {}) {
    if (!(typeof approvedUsd === 'number' && Number.isFinite(approvedUsd) && approvedUsd >= 0)) throw new BudgetError('BUDGET_INVALID', `presupuesto aprobado inválido: ${approvedUsd}`);
    this.approved = approvedUsd;
    this.ledgerFile = o.ledgerFile || null;
    this.runId = o.runId || `run-${process.pid}-${Date.now()}`;
    this.prior = o.ledgerFile ? readLedger(o.ledgerFile) : { spentUsd: Number(o.priorSpentUsd) || 0, settled: 0, orphanReserves: 0, runs: 0, lines: 0 };
    this.spent = 0; // de ESTA corrida
    this.reserved = 0;
    this.calls = 0;
    this.seq = 0;
    this.label = o.label || 'modelab';
    if (this.prior.spentUsd >= this.approved) throw new BudgetError('BUDGET_EXHAUSTED', `${this.label}: ya se gastaron ${this.prior.spentUsd.toFixed(4)} USD de ${this.approved.toFixed(2)} aprobados en corridas anteriores (${this.ledgerFile})`, { priorSpentUsd: this.prior.spentUsd });
  }
  get remaining() { return this.approved - this.prior.spentUsd - this.spent - this.reserved; }
  _append(e) { if (this.ledgerFile) fs.appendFileSync(this.ledgerFile, JSON.stringify({ ts: new Date().toISOString(), runId: this.runId, ...e }) + '\n'); }
  reserve(upperUsd, meta = {}) {
    if (!(upperUsd >= 0)) throw new BudgetError('BUDGET_INVALID', `cota inválida ${upperUsd}`);
    const total = this.prior.spentUsd + this.spent;
    if (total + this.reserved + upperUsd > this.approved + 1e-9) {
      throw new BudgetError('BUDGET_EXCEEDED', `${this.label}: gastado ${total.toFixed(4)} (previo ${this.prior.spentUsd.toFixed(4)}) + reservado ${this.reserved.toFixed(4)} + cota ${upperUsd.toFixed(4)} > aprobado ${this.approved.toFixed(2)} USD`, { spent: total, approved: this.approved });
    }
    this.reserved += upperUsd;
    const rid = ++this.seq;
    this._append({ kind: 'reserve', rid, upperUsd, ...meta });
    return { upperUsd, rid };
  }
  settle(res, actualUsd, meta = {}) {
    this.reserved = Math.max(0, this.reserved - res.upperUsd);
    this.spent += actualUsd;
    this.calls++;
    this._append({ kind: 'settle', rid: res.rid, usd: actualUsd, ...meta });
  }
  snapshot() {
    const r = (x) => Math.round(x * 1e6) / 1e6;
    return { approvedUsd: this.approved, priorSpentUsd: r(this.prior.spentUsd), spentUsd: r(this.spent), totalSpentUsd: r(this.prior.spentUsd + this.spent), reservedUsd: r(this.reserved), remainingUsd: r(this.remaining), calls: this.calls, ledgerFile: this.ledgerFile, runId: this.runId };
  }
}

/** Chequeo previo: la proyección (con margen) debe caber en lo que QUEDA del presupuesto, o no se hace NINGUNA llamada. */
function assertPreflight(projectedUsd, approvedUsd, margin = 1.25, priorSpentUsd = 0) {
  const need = projectedUsd * margin;
  const left = approvedUsd - priorSpentUsd;
  if (need > left) throw new BudgetError('BUDGET_PREFLIGHT_EXCEEDED', `proyección ${projectedUsd.toFixed(3)} × margen ${margin} = ${need.toFixed(3)} USD > disponible ${left.toFixed(3)} USD (aprobado ${approvedUsd.toFixed(2)} − gastado antes ${priorSpentUsd.toFixed(3)})`, { projectedUsd, approvedUsd, priorSpentUsd });
  return { projectedUsd, withMarginUsd: need, approvedUsd, priorSpentUsd, availableUsd: left };
}

module.exports = { BudgetGuard, BudgetError, assertPreflight, readLedger, ledgerPath };
