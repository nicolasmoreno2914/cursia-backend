/**
 * DoD follow-up fix round 1 (m2): GET /jobs y /jobs/:id devuelven las filas crudas de production_jobs del
 * dueño. La marca del empaque automático de un run (`output_summary.autoPackage.blocked`) guarda el
 * mensaje del servidor para el admin (hasta 400 caracteres, con `missingJson=[…]`) y la lista de
 * faltantes: a quien NO es SUPER_ADMIN solo le llega el código y el instante (mismo criterio que R3 en el
 * RunDto). Pura; devuelve una copia solo si hay algo que quitar (nunca muta la fila).
 */
export function redactJobForOwner<T extends { executionMode?: string | null; outputSummary?: any }>(job: T): T {
  if (!job || job.executionMode !== 'dynamic_generation') return job;
  const os = job.outputSummary;
  const ap = os && typeof os === 'object' ? os.autoPackage : null;
  const b = ap && typeof ap === 'object' ? ap.blocked : null;
  if (!b || typeof b !== 'object' || (!('message' in b) && !('missing' in b))) return job;
  const { message: _m, missing: _x, ...rest } = b as Record<string, unknown>;
  return { ...job, outputSummary: { ...os, autoPackage: { ...ap, blocked: { ...rest, message: null } } } };
}
