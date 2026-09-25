/**
 * F78-BE2: generaciones de un item dentro de un run.
 *
 * Un item del Manifest puede tener varias filas en `generation_item_runs`
 * dentro del MISMO run (job): generation 1 (siembra) y, por cada regeneración
 * explícita del usuario (`POST …/items/:itemKey/regenerate`), una fila nueva
 * con generation = max + 1 e idempotency key propia. Las filas viejas nunca
 * se reescriben (histórico); la vigente se decide acá, en SQL, con una sola
 * definición compartida por todo el backend:
 *
 * - Estado del run (progreso, RunDto, recálculo del run, claim, dependencias,
 *   retry, reapertura): la generación MÁS ALTA de cada item_key
 *   (`latestGenerationPredicate`), en cualquier estado — una regeneración en
 *   vuelo (pending/running) o fallida es lo que el run está haciendo.
 * - Salida (resolver de empaquetado, precheck del paquete, Coherence, entrada
 *   LLM, loader de invalidación): la generación `completed` más alta de cada
 *   item_key; si ninguna está completed, la más alta (para reportarla como
 *   faltante con su estado real) — `effectiveOutputRowsSql`.
 */

/** Predicado SQL: `alias` es la generación más alta de su item_key dentro de su run (job_id). */
export function latestGenerationPredicate(alias: string): string {
  return `not exists (
              select 1 from public.generation_item_runs gir_newer
               where gir_newer.job_id = ${alias}.job_id
                 and gir_newer.item_key = ${alias}.item_key
                 and gir_newer.generation > ${alias}.generation)`;
}

/**
 * Subconsulta (usable como tabla) con UNA fila por item_key del run
 * `jobParam` (placeholder, p.ej. `$1`): la generación completed más alta, o
 * la más alta si ninguna completó. Mismas columnas que generation_item_runs.
 */
export function effectiveOutputRowsSql(jobParam: string): string {
  return `(select distinct on (gir_eff.item_key) gir_eff.*
             from public.generation_item_runs gir_eff
            where gir_eff.job_id = ${jobParam}
            order by gir_eff.item_key, (gir_eff.status = 'completed') desc, gir_eff.generation desc)`;
}
