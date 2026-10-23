// ─────────────────────────────────────────────────────────────────────────────
// r62 (d8) — `claim_payload_unavailable`: el claim de una parte no se pudo armar porque falta un DATO de su dependencia
// (hoy: `video_interactions` sin los datos del video de su capítulo — youtubeId, duración medida, plan de reflexión —,
// scheduler.service.ts loadVideoFacts). Antes quedaba `failed` (D, product_bug) hasta que un humano regenerara.
// Estrategia `regenerate_dependency`, automática:
//  - la dependencia todavía NO está completada (`VIDEO_NOT_COMPLETED`: carrera con una regeneración/reapertura): se espera
//    a que su propia recuperación la complete y entonces la parte se reabre sola (sin gasto: el claim falló antes de
//    cualquier llamada), a lo sumo CLAIM_PAYLOAD_MAX_REOPENS veces;
//  - la dependencia está completada pero su dato no sirve: se REGENERA la dependencia UNA vez (regenerateItem con su gate
//    de FinOps: dentro del saldo autorizado del run; la cascada regenera también a la parte); si ya se regeneró una vez
//    por esto, o el presupuesto no alcanza → excepción registrada (attention_reason explícito);
//  - un código de CONTRATO (minutos de práctica / aplicación, brief pedagógico) no depende de otra parte → sigue D.
// Puro.
// ─────────────────────────────────────────────────────────────────────────────

export const CLAIM_PAYLOAD_UNAVAILABLE = 'claim_payload_unavailable';
/** Motivo de la generación nueva de la dependencia (output_summary.regeneration.reason). */
export const CLAIM_PAYLOAD_DEPENDENCY_REASON = 'claim_payload_dependency';
export const CLAIM_PAYLOAD_DEPENDENCY_STRATEGY = 'regenerate_dependency:claim_payload';
export const CLAIM_PAYLOAD_RESUME_STRATEGY = 'dependency_resolved:claim_payload';
/**
 * r62 (re-review m5): techo de la completitud — si el barrido no resolvió la parte (ni la reabrió ni la registró como
 * excepción) dentro de este tiempo desde el fallo, la acción de admin aparece igual (p. ej. el barrido falla en cada tick).
 */
export const CLAIM_PAYLOAD_SWEEP_CEILING_MS = 30 * 60_000;
/** Reaperturas gratuitas máximas de la parte tras resolverse su dependencia (anti-bucle). */
export const CLAIM_PAYLOAD_MAX_REOPENS = 3;

/**
 * Códigos internos (ClaimPayloadUnavailable.code) que dependen de OTRA parte (el video del capítulo) — review N1 I1: solo
 * datos de ENTREGA / MEDICIÓN o una carrera. `VIDEO_PLAN_INVARIANT` (bug determinista) y `VIDEO_DURATION_INVALID` (el
 * video excede el máximo: regenerar lo repetiría) NO entran: son `product_bug` (excepción, sin regenerar).
 */
export const CLAIM_PAYLOAD_DEPENDENCY_CODES: readonly string[] = Object.freeze(['VIDEO_NOT_COMPLETED', 'VIDEO_YOUTUBE_ID_MISSING', 'VIDEO_DURATION_MISSING']);
/** Mismo conjunto como regex (clasificador / vista). */
export const CLAIM_PAYLOAD_DEPENDENCY_RE = /^claim_payload_unavailable:\s*(?:VIDEO_NOT_COMPLETED|VIDEO_YOUTUBE_ID_MISSING|VIDEO_DURATION_MISSING)\b/;

export interface ClaimPayloadRow {
  type: string;
  chapter_id?: string | null;
  error: string | null;
  output_summary?: Record<string, any> | null;
  finished_at?: Date | string | null;
}

export interface ClaimPayloadDependencyRow {
  item_key: string;
  status: string;
  generation: number;
  output_summary?: Record<string, any> | null;
  finished_at?: Date | string | null;
}

export type ClaimPayloadDecision =
  | { action: 'reopen'; depKey: string; code: string }
  | { action: 'regenerate_dependency'; depKey: string; code: string }
  | { action: 'wait'; depKey: string; code: string }
  | { action: 'exception'; depKey: string | null; code: string; reason: 'contract' | 'already_regenerated' | 'reopen_cap' | 'real_video_requires_review' | 'dependency_unavailable' };

/** r62 (re-review 3): estados de la dependencia que todavía pueden terminar solos (esperar). */
export const CLAIM_PAYLOAD_DEP_ALIVE: readonly string[] = Object.freeze(['pending', 'queued', 'claimed', 'running', 'retrying', 'blocked']);
/** r62 (re-review 3): estados terminales SIN salida automática (no va a completarse): excepción registrada. */
export const CLAIM_PAYLOAD_DEP_DEAD: readonly string[] = Object.freeze(['cancelled', 'skipped']);

/** Código interno del mensaje `claim_payload_unavailable: <CODE>: …` (null si no tiene la forma). */
export function claimPayloadCodeOf(error: string | null | undefined): string | null {
  const m = /^claim_payload_unavailable:\s*([A-Za-z][A-Za-z0-9_]*)\b/.exec(String(error ?? ''));
  return m ? m[1] : null;
}

/** Clave de la dependencia productora del dato que faltó, o null si el código no depende de otra parte. */
export function claimPayloadDependencyKey(row: ClaimPayloadRow): string | null {
  const code = claimPayloadCodeOf(row.error);
  if (!code || row.type !== 'video_interactions' || !row.chapter_id) return null;
  return CLAIM_PAYLOAD_DEPENDENCY_CODES.includes(code) ? `video:${row.chapter_id}` : null;
}

function ms(v: Date | string | null | undefined): number {
  if (!v) return NaN;
  return (v instanceof Date ? v : new Date(v)).getTime();
}

/**
 * `videoMode`: modo de video del run (sin dato = `real`: falla cerrado, re-review m5). Review N1 I1: regenerar la dependencia SOLO con video `mock` (sin costo). Con video
 * REAL regenerar sería un render NUEVO pagado en Videogen sobre uno ya pagado (y la vía gratis —re-consultar el job,
 * re-medir el MP4 y re-subir a YouTube de forma idempotente— no está implementada acá): excepción explícita para un humano
 * (`real_video_requires_review`), nunca un repago automático.
 */
export function claimPayloadRecoveryDecision(row: ClaimPayloadRow, dep: ClaimPayloadDependencyRow | null, videoMode: string = 'real'): ClaimPayloadDecision {
  const code = claimPayloadCodeOf(row.error) ?? 'unknown';
  const depKey = claimPayloadDependencyKey(row);
  if (!depKey) return { action: 'exception', depKey: null, code, reason: 'contract' };
  if (!dep) return { action: 'wait', depKey, code };
  const reopens = Math.max(0, Math.floor(Number(row.output_summary?.claimPayloadRecovery?.reopens ?? 0)) || 0);
  const regeneratedForThis = dep.output_summary?.regeneration?.reason === CLAIM_PAYLOAD_DEPENDENCY_REASON;
  // La dependencia (re)completó DESPUÉS del fallo del claim: el dato pudo haber cambiado → la parte se reabre gratis.
  const depNewer = dep.status === 'completed' && Number.isFinite(ms(dep.finished_at)) && Number.isFinite(ms(row.finished_at))
    && ms(dep.finished_at) > ms(row.finished_at);
  if (dep.status === 'completed' && (code === 'VIDEO_NOT_COMPLETED' || depNewer)) {
    if (reopens >= CLAIM_PAYLOAD_MAX_REOPENS) return { action: 'exception', depKey, code, reason: 'reopen_cap' };
    return { action: 'reopen', depKey, code };
  }
  // r62 (re-review 3): una dependencia cancelada / omitida nunca se va a completar → excepción explícita (sin esperar).
  if (CLAIM_PAYLOAD_DEP_DEAD.includes(dep.status)) return { action: 'exception', depKey, code, reason: 'dependency_unavailable' };
  if (dep.status !== 'completed') return { action: 'wait', depKey, code };
  if (regeneratedForThis) return { action: 'exception', depKey, code, reason: 'already_regenerated' };
  if (videoMode !== 'mock') return { action: 'exception', depKey, code, reason: 'real_video_requires_review' };
  return { action: 'regenerate_dependency', depKey, code };
}
