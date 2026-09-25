import { createHash } from 'crypto';

/**
 * Canonical JSON with recursively sorted object keys. Array order is kept
 * as-is (callers sort arrays whose order is not semantic BEFORE calling).
 * `undefined` values in objects are dropped (same as JSON.stringify), so an
 * absent optional field and an explicit `undefined` hash the same.
 *
 * Used by the Coherence Engine (Fase 7) and the Invalidation plan (Fase 8)
 * for every hash that must be independent of object key order (e.g. a
 * document round-tripped through Postgres jsonb).
 */
export function sortedCanonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => sortKeysDeep(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256Canonical(value: unknown): string {
  return sha256Hex(sortedCanonicalJson(value));
}

/** Deterministic string compare (code-unit order, locale-independent). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
