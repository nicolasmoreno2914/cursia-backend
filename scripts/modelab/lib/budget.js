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
const os = require('os');
const path = require('path');

/** Review r61 R1: tope DURO del TOTAL real entre TODOS los experimentos del ledger (cambiarlo exige cambiar el código). */
const GLOBAL_REAL_CAP_USD = 10;
/** Ledger real en una ubicación FIJA y absoluta, compartida entre experimentos (--out solo guarda informes/respuestas). */
function realLedgerDir(env = process.env) {
  const d = env.MODELAB_LEDGER_DIR ? path.resolve(env.MODELAB_LEDGER_DIR) : path.join(os.homedir(), 'cursia-test-env', 'work', 'modelab-ledger');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** Gasto total (peor caso) de todos los ledgers reales del directorio. */
function globalSpent(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => /^modelab-ledger-.+-real\.jsonl$/.test(f)).reduce((s, f) => s + readLedger(path.join(dir, f)).spentUsd, 0);
}

class BudgetError extends Error { constructor(code, msg, extra) { super(`${code}: ${msg}`); this.code = code; Object.assign(this, extra || {}); } }

function ledgerPath(outDir, experimentId, mode) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(experimentId))) throw new BudgetError('BUDGET_INVALID', `id de experimento inválido: ${experimentId}`);
  return path.join(outDir, `modelab-ledger-${experimentId}-${mode}.jsonl`);
}

/** Lee el ledger: gasto previo (con reservas huérfanas al peor caso). Línea ilegible = fail loud (no se adivina). */
function readLedger(file) {
  if (!fs.existsSync(file)) return { spentUsd: 0, settled: 0, orphanReserves: 0, runs: 0, lines: 0, approvedUsd: null, approvals: [] };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const open = new Map();
  let spent = 0, settled = 0;
  const runs = new Set();
  const approvals = [];
  lines.forEach((l, i) => {
    let e;
    try { e = JSON.parse(l); } catch { throw new BudgetError('BUDGET_LEDGER_CORRUPT', `${file}:${i + 1} ilegible`); }
    runs.add(e.runId);
    if (e.kind === 'approval') approvals.push(e);
    else if (e.kind === 'reserve') open.set(`${e.runId}|${e.rid}`, e.upperUsd);
    else if (e.kind === 'settle') { open.delete(`${e.runId}|${e.rid}`); spent += Number(e.usd) || 0; settled++; }
  });
  let orphan = 0;
  for (const u of open.values()) { spent += Number(u) || 0; orphan++; }
  return { spentUsd: spent, settled, orphanReserves: orphan, runs: runs.size, lines: lines.length, approvedUsd: approvals.length ? approvals[approvals.length - 1].approvedUsd : null, approvals };
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
    // Review r61 R2: la aprobación queda en el ledger (1.ª línea del experimento). Otro monto exige --approval-note.
    if (this.ledgerFile) {
      const prevApproved = this.prior.approvedUsd;
      if (prevApproved === null || prevApproved === undefined) this._append({ kind: 'approval', approvedUsd: this.approved, note: o.approvalNote || null });
      else if (Math.abs(prevApproved - this.approved) > 1e-9) {
        if (!o.approvalNote || !String(o.approvalNote).trim()) throw new BudgetError('BUDGET_APPROVAL_MISMATCH', `${this.label}: el experimento se aprobó por ${prevApproved} USD y se pide ${this.approved}; un cambio exige --approval-note="<motivo y quién aprobó>"`, { prevApproved });
        this._append({ kind: 'approval', approvedUsd: this.approved, previousApprovedUsd: prevApproved, note: String(o.approvalNote).trim() });
      }
    }
    // Review r61 R1: tope global (todos los experimentos del directorio de ledgers reales).
    this.globalCapUsd = o.globalCapUsd ?? null;
    this.globalPriorUsd = o.globalLedgerDir ? globalSpent(o.globalLedgerDir) : 0;
    if (this.globalCapUsd !== null && this.globalPriorUsd >= this.globalCapUsd) throw new BudgetError('BUDGET_GLOBAL_CAP_EXHAUSTED', `${this.label}: el total real de todos los experimentos (${this.globalPriorUsd.toFixed(4)} USD) ya alcanzó el tope duro de ${this.globalCapUsd} USD`, { globalPriorUsd: this.globalPriorUsd });
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
    if (this.globalCapUsd !== null && this.globalPriorUsd + this.spent + this.reserved + upperUsd > this.globalCapUsd + 1e-9) {
      throw new BudgetError('BUDGET_EXCEEDED', `${this.label}: el total real de todos los experimentos (${(this.globalPriorUsd + this.spent).toFixed(4)} + reservado ${this.reserved.toFixed(4)} + cota ${upperUsd.toFixed(4)}) superaría el tope duro global de ${this.globalCapUsd} USD`, { global: true });
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
    return { approvedUsd: this.approved, globalCapUsd: this.globalCapUsd, globalPriorUsd: r(this.globalPriorUsd || 0), priorSpentUsd: r(this.prior.spentUsd), spentUsd: r(this.spent), totalSpentUsd: r(this.prior.spentUsd + this.spent), reservedUsd: r(this.reserved), remainingUsd: r(this.remaining), calls: this.calls, ledgerFile: this.ledgerFile, runId: this.runId };
  }
}

/** Chequeo previo: la proyección (con margen) debe caber en lo que QUEDA del presupuesto, o no se hace NINGUNA llamada. */
function assertPreflight(projectedUsd, approvedUsd, margin = 1.25, priorSpentUsd = 0) {
  const need = projectedUsd * margin;
  const left = approvedUsd - priorSpentUsd;
  if (need > left) throw new BudgetError('BUDGET_PREFLIGHT_EXCEEDED', `proyección ${projectedUsd.toFixed(3)} × margen ${margin} = ${need.toFixed(3)} USD > disponible ${left.toFixed(3)} USD (aprobado ${approvedUsd.toFixed(2)} − gastado antes ${priorSpentUsd.toFixed(3)})`, { projectedUsd, approvedUsd, priorSpentUsd });
  return { projectedUsd, withMarginUsd: need, approvedUsd, priorSpentUsd, availableUsd: left };
}

module.exports = { BudgetGuard, BudgetError, assertPreflight, readLedger, ledgerPath, realLedgerDir, globalSpent, GLOBAL_REAL_CAP_USD };
