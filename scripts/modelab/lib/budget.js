/* eslint-disable */
// r61 (F) — MODELAB · guardia de presupuesto (dura). Antes de CADA llamada real se reserva su cota superior
// (entrada a precio de escritura de caché + max_tokens de salida); si gastado + reservado + cota > aprobado, la llamada
// NO se hace y la corrida aborta con BUDGET_EXCEEDED (el informe parcial se escribe igual). Un error de red/5xx deja la
// cota reservada como gasto (gasto desconocido = se asume el peor caso).
'use strict';

class BudgetError extends Error { constructor(code, msg, extra) { super(`${code}: ${msg}`); this.code = code; Object.assign(this, extra || {}); } }

class BudgetGuard {
  constructor(approvedUsd, o = {}) {
    if (!(typeof approvedUsd === 'number' && Number.isFinite(approvedUsd) && approvedUsd >= 0)) throw new BudgetError('BUDGET_INVALID', `presupuesto aprobado inválido: ${approvedUsd}`);
    this.approved = approvedUsd;
    this.spent = 0;
    this.reserved = 0;
    this.calls = 0;
    this.label = o.label || 'modelab';
  }
  reserve(upperUsd) {
    if (!(upperUsd >= 0)) throw new BudgetError('BUDGET_INVALID', `cota inválida ${upperUsd}`);
    if (this.spent + this.reserved + upperUsd > this.approved + 1e-9) {
      throw new BudgetError('BUDGET_EXCEEDED', `${this.label}: gastado ${this.spent.toFixed(4)} + reservado ${this.reserved.toFixed(4)} + cota ${upperUsd.toFixed(4)} > aprobado ${this.approved.toFixed(2)} USD`, { spent: this.spent, approved: this.approved });
    }
    this.reserved += upperUsd;
    return { upperUsd };
  }
  settle(res, actualUsd) {
    this.reserved = Math.max(0, this.reserved - res.upperUsd);
    this.spent += actualUsd;
    this.calls++;
  }
  snapshot() { return { approvedUsd: this.approved, spentUsd: Math.round(this.spent * 1e6) / 1e6, reservedUsd: Math.round(this.reserved * 1e6) / 1e6, calls: this.calls }; }
}

/** Chequeo previo: la proyección (con margen) debe caber en lo aprobado, o no se hace NINGUNA llamada. */
function assertPreflight(projectedUsd, approvedUsd, margin = 1.25) {
  const need = projectedUsd * margin;
  if (need > approvedUsd) throw new BudgetError('BUDGET_PREFLIGHT_EXCEEDED', `proyección ${projectedUsd.toFixed(3)} × margen ${margin} = ${need.toFixed(3)} USD > aprobado ${approvedUsd.toFixed(2)} USD`, { projectedUsd, approvedUsd });
  return { projectedUsd, withMarginUsd: need, approvedUsd };
}

module.exports = { BudgetGuard, BudgetError, assertPreflight };
