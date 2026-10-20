// ─────────────────────────────────────────────────────────────────────────────
// r62 (N2, E2E `videogen_never_finishes`) — tope ÚNICO de render de un job de Videogen.
//
// Antes había dos números: el worker re-polleaba gratis 3 h (VIDEO_TIMEOUT_FREE_WALL_MS) y después consumía
// intentos/rondas del auto-healer re-polleando el MISMO job (nunca creaba un job nuevo), y la conciliación lo daba por
// vivo hasta 12 h. Mientras tanto la parte quedaba running/retrying (el retry de admin respondía 409) y no había salida.
// Ahora: mientras Videogen informe un estado no terminal se espera (gratis, sin reenviar); al pasar este tope, contado
// desde el primer poll del job (`videoPollSince`), el worker deja la parte `failed` con `videogen_render_overdue` y la
// conciliación decide (cancelar un job todavía encolado y reenviar con evidencia, o la excepción explícita
// `provider_stuck_no_cancel` si el job está procesando: la cancelación de Videogen no detiene un job activo).
// Default 3 h: el valor que el worker ya usaba como espera normal (un render observado tarda minutos); configurable
// para el harness (minutos).
// ─────────────────────────────────────────────────────────────────────────────
export const DYNAMIC_VIDEOGEN_MAX_RENDER_MS_ENV = 'DYNAMIC_VIDEOGEN_MAX_RENDER_MS';
export const DYNAMIC_VIDEOGEN_MAX_RENDER_MS_DEFAULT = 3 * 60 * 60_000;
/** Código con el que el worker deja la parte cuando el job sigue vivo pasado el tope. */
export const VIDEOGEN_RENDER_OVERDUE = 'videogen_render_overdue';
/** Motivo de la excepción (c) cuando el job sigue procesando y no hay cancelación efectiva. */
export const PROVIDER_STUCK_NO_CANCEL = 'provider_stuck_no_cancel';

export function videogenMaxRenderMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env[DYNAMIC_VIDEOGEN_MAX_RENDER_MS_ENV]);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DYNAMIC_VIDEOGEN_MAX_RENDER_MS_DEFAULT;
}

export function videogenRenderOverdueMessage(jobId: string, status: string | null, elapsedMs: number, capMs: number): string {
  const h = (ms: number) => `${(ms / 3_600_000).toFixed(2)} h`;
  return `${VIDEOGEN_RENDER_OVERDUE}: el job de Videogen ${jobId} sigue ${status || 'sin terminar'} tras ${h(elapsedMs)} ` +
    `(tope ${h(capMs)}, ${DYNAMIC_VIDEOGEN_MAX_RENDER_MS_ENV}). No se reenvía solo con el job vivo (posible render doble pagado); ` +
    `la conciliación lo cancela si sigue encolado o deja la excepción explícita.`;
}
