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
/** Reaperturas gratuitas máximas de la parte tras resolverse su dependencia (anti-bucle). */
export const CLAIM_PAYLOAD_MAX_REOPENS = 3;

/** Códigos internos (ClaimPayloadUnavailable.code) que dependen de OTRA parte: la dependencia es el video del capítulo. */
const VIDEO_DEPENDENCY_CODE_RE = /^VIDEO_[A-Z0-9_]+$/;

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
  | { action: 'exception'; depKey: string | null; code: string; reason: 'contract' | 'already_regenerated' | 'reopen_cap' };

/** Código interno del mensaje `claim_payload_unavailable: <CODE>: …` (null si no tiene la forma). */
export function claimPayloadCodeOf(error: string | null | undefined): string | null {
  const m = /^claim_payload_unavailable:\s*([A-Za-z][A-Za-z0-9_]*)\b/.exec(String(error ?? ''));
  return m ? m[1] : null;
}

/** Clave de la dependencia productora del dato que faltó, o null si el código no depende de otra parte. */
export function claimPayloadDependencyKey(row: ClaimPayloadRow): string | null {
  const code = claimPayloadCodeOf(row.error);
  if (!code || row.type !== 'video_interactions' || !row.chapter_id) return null;
  return VIDEO_DEPENDENCY_CODE_RE.test(code) ? `video:${row.chapter_id}` : null;
}

function ms(v: Date | string | null | undefined): number {
  if (!v) return NaN;
  return (v instanceof Date ? v : new Date(v)).getTime();
}

export function claimPayloadRecoveryDecision(row: ClaimPayloadRow, dep: ClaimPayloadDependencyRow | null): ClaimPayloadDecision {
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
  if (dep.status !== 'completed') return { action: 'wait', depKey, code };
  if (regeneratedForThis) return { action: 'exception', depKey, code, reason: 'already_regenerated' };
  return { action: 'regenerate_dependency', depKey, code };
}
