/* eslint-disable */
// V2.1 RF-b (fix round 2) — fakes PERMISIVOS de FinOps para los checks de otros
// bloques que ejercitan caminos de gasto real con proveedores falsos.
//
// El runtime guard y los gates de presupuesto FALLAN CERRADOS cuando falta su
// dependencia (review G3 M3): un check que quiere probar OTRA cosa (entrega de
// video, providerModes, invalidación) inyecta estos fakes, que siempre permiten.
// El comportamiento de presupuesto real se prueba en check-v21-finops-wiring.js.
const fs = require('fs');
const path = require('path');

const PERMISSIVE_GUARD = Object.freeze({
  allow: true, decision: 'ALLOW', committed: '0', remaining: null, reason: 'test_permissive', authorizedBudget: '1000000',
});

/** Runtime guard (workers) que siempre permite. */
function permissiveBudgetGuard() {
  return { async guardPaidSubmission() { return { ...PERMISSIVE_GUARD }; } };
}

/**
 * FinopsBudgetService falso para RunsService: estima con el estimador PURO real
 * (seed de precios del repo), decide siempre AUTO y nunca escribe en la DB.
 * `F` = dist/modules/finops/index.js.
 */
function permissiveFinopsBudget(F, repoRoot = path.resolve(__dirname, '..', '..')) {
  const seed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/modules/finops/pricing-seed.v1.json'), 'utf8'));
  const catalog = seed.rows.map((r, i) => ({ id: `seed-${i}`, ...r }));
  const estimate = async (items) => F.estimateCost({ items, catalog, usageModel: F.usageModelPriorsV1(), retryPolicy: { maxRetries: 1 } });
  return {
    estimate,
    async evaluateStart(a) {
      const estimateItems = F.estimateItemsForRun(a.items, a.mode, a.actions ?? null);
      return { decision: 'AUTO_WITHIN_POLICY', reasons: ['test_permissive'], paidRealProviders: [], estimate: await estimate(estimateItems), estimateItems, policyId: null };
    },
    async findUnconsumedApproval() { return null; },
    async bindRun() { return { estimateId: null, authorizationId: null }; },
    async recordEstimate() { return { id: '00000000-0000-4000-8000-000000000000' }; },
    async runPaidAuthorizedBudget() { return '1000000'; },
    async runAuthorizedBudget() { return '1000000'; },
    async runActual() { return '0'; },
    async historicalByItemRun() { return {}; },
    async recordAvoidance() { return { inserted: false }; },
    async guardPaidSubmission() { return { ...PERMISSIVE_GUARD }; },
  };
}

module.exports = { permissiveBudgetGuard, permissiveFinopsBudget, PERMISSIVE_GUARD };
