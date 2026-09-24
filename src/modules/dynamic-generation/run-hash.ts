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

/** Campos string del contexto (orden fijo de construcción; el hash ordena claves igual). */
export const CONTEXT_STRING_FIELDS = ['nombre', 'sector', 'pais', 'ciudad', 'contexto', 'nivel', 'tono', 'obj'] as const;
/** Obligatorios: vacíos tras normalizar → 400 (lo decide el servicio). */
export const REQUIRED_CONTEXT_FIELDS = ['nombre', 'sector', 'pais', 'contexto', 'nivel', 'tono'] as const;

/**
 * Normalización del contexto ANTES de hashear Y de guardar (fix ronda 1):
 * la auditoría recalcula el hash sobre el jsonb guardado, así que lo que se
 * guarda debe ser exactamente lo normalizado.
 *
 * - Todos los strings se recortan (`trim`).
 * - Un campo opcional (o cualquiera) `null`, `""` o solo espacios se trata
 *   como AUSENTE (la clave no se guarda) → `ciudad: ""`, `ciudad: "  "`,
 *   `ciudad: null` y sin `ciudad` producen el mismo contexto y el mismo hash.
 * - `prevCourse` null/ausente → ausente; si viene: `nombre` recortado y
 *   `caps` con cada entrada recortada, descartando las vacías (orden
 *   conservado).
 * - Solo se copian las claves conocidas (el DTO ya rechazó las demás).
 *
 * Luego `canonicalContextHash` aplica la forma canónica de la auditoría.
 */
export function normalizeCourseContext(input: any): Record<string, any> {
  const clean = (v: any) => (typeof v === 'string' ? v.trim() : v);
  const out: Record<string, any> = {};
  for (const k of CONTEXT_STRING_FIELDS) {
    const v = clean(input?.[k]);
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  const pc = input?.prevCourse;
  if (pc !== undefined && pc !== null) {
    const nombre = clean(pc.nombre);
    const caps = Array.isArray(pc.caps)
      ? pc.caps.map(clean).filter((c: any) => c !== undefined && c !== null && c !== '')
      : [];
    out.prevCourse = { nombre: nombre ?? '', caps };
  }
  return out;
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
