import { createHash } from 'crypto';

/**
 * Forma canónica del contexto congelado de un run (Fase 5A). DEBE ser
 * idéntica a `sortKeysDeep`/`canonicalContextHash` de
 * scripts/audit-dynamic-generation.js (la auditoría recalcula
 * `generation_run_contexts.context_hash` con esa función; el harness de
 * Task 2 compara ambas sobre un ejemplo anidado):
 *
 *   context_hash = sha256(JSON.stringify(sortKeysDeep(JSON.parse(JSON.stringify(context))))) en hex
 *
 * - El roundtrip JSON normaliza cualquier valor no-JSON (Date → ISO,
 *   `undefined` desaparece de objetos) antes de hashear.
 * - Las claves de objetos se ordenan con `Object.keys(v).sort()` (orden
 *   UTF-16, "10" antes que "9"); los arrays conservan su orden.
 */
export function sortKeysDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/** JSON plano (roundtrip) del contexto — lo que se guarda en `generation_run_contexts.context`. */
export function plainContext<T>(context: T): T {
  return JSON.parse(JSON.stringify(context));
}

export function canonicalContextHash(context: unknown): string {
  const plainJson = plainContext(context);
  return createHash('sha256').update(JSON.stringify(sortKeysDeep(plainJson))).digest('hex');
}

/**
 * Clave de idempotencia externa de un item (spec §3.3): determinística por
 * Manifest + item + generation — misma forma que `idempotencyKey` de la
 * auditoría.
 */
export function itemIdempotencyKey(manifestId: number, itemKey: string, generation: number): string {
  return createHash('sha256').update(`${manifestId}:${itemKey}:${generation}`).digest('hex');
}
