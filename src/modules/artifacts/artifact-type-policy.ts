/**
 * r58 (AU1 R1/R2) — política de tipos y procedencia de los artifacts que registra el CLIENTE
 * (`POST /api/v1/artifacts`). Sin dependencias (la importan el servicio de artifacts, el scheduler
 * y el empaque).
 *
 * Tipos SOLO del servidor: los crean exclusivamente workers del backend con la service role
 * (`uploadBufferArtifact` / INSERT propio), nunca el navegador. Lista sacada del código:
 *  - `dynamic_mbz`                    → dynamic-package-worker (paquete final / QA);
 *  - `dynamic_presentation`           → dynamic-provider-worker / provider-real (Gamma);
 *  - `dynamic_audio_mp3`              → dynamic-provider-worker / provider-real (TTS);
 *  - `dynamic_audio_segment`          → provider-real (segmentos del audiolibro);
 *  - `dynamic_video`                  → dynamic-item-worker (Videogen / YouTube);
 *  - `dynamic_coherence_report_json`  → coherence.service (reporte del motor de coherencia).
 * El ejecutor del navegador (45-dynamic-generation-executor.js → dynArtifactUpload) sube SOLO los
 * tipos LLM (`dynamic_content_md`, `dynamic_scorm_*`, `dynamic_exam_*`, `dynamic_*_json` de plan,
 * intros, experiencia, H5P, interacciones, aplicación, práctica guiada, contexto, borradores) y el
 * flujo legacy sube `mbz_final`, `content_snapshot`, `h5p_snapshot`, audios legacy, etc.: esos NO se
 * bloquean.
 */
export const SERVER_ONLY_ARTIFACT_TYPES: readonly string[] = Object.freeze([
  'dynamic_mbz',
  // r74: partes del paquete autocontenido (principal sin MP3 + partes de audio) y MP3 del audiolibro en línea.
  'dynamic_mbz_part',
  'dynamic_media_audio',
  'dynamic_presentation',
  'dynamic_audio_mp3',
  'dynamic_audio_segment',
  'dynamic_video',
  'dynamic_coherence_report_json',
]);

/** 403 de `POST /artifacts` con un tipo que solo crea el servidor (clase: rechazo de cliente, no reintentable). */
export const ARTIFACT_TYPE_SERVER_ONLY = 'artifact_type_server_only';

export function isServerOnlyArtifactType(type: unknown): boolean {
  return typeof type === 'string' && SERVER_ONLY_ARTIFACT_TYPES.includes(type.trim());
}

// ─── R2: procedencia del texto LLM ──────────────────────────────────────────

/**
 * Modo del LLM que produjo un artifact / item:
 *  - `real`   → llamada real al proveedor (default; el único entregable);
 *  - `mock`   → LLM falso (harness, e2e, simulación);
 *  - `replay` → respuesta reproducida de un fixture / checkpoint grabado.
 * Se declara en `metadata.llmMode` del artifact (el ejecutor / driver) y el servidor lo resume en
 * `output_summary.llmMode` del item al completar (clave del servidor: el ejecutor solo puede
 * DEGRADAR la procedencia, nunca declarar `real` sobre un artifact marcado mock/replay).
 */
export type LlmMode = 'real' | 'mock' | 'replay';
export const LLM_MODES: readonly LlmMode[] = Object.freeze(['real', 'mock', 'replay']) as readonly LlmMode[];
/** 400 de `POST /artifacts` / rechazo del complete con un `llmMode` fuera de LLM_MODES (clase: rechazo de cliente). */
export const LLM_MODE_INVALID = 'llm_mode_invalid';

export function isLlmMode(v: unknown): v is LlmMode {
  return typeof v === 'string' && (LLM_MODES as readonly string[]).includes(v);
}

/** ¿Procedencia NO real (mock / replay)? Lo ausente es `real` (filas anteriores a r58). */
export function isNonRealLlmMode(v: unknown): boolean {
  return v === 'mock' || v === 'replay';
}

/**
 * Combina declaraciones de procedencia (resumen del ejecutor + metadata de cada artifact): la peor
 * gana (`mock` > `replay` > `real`). Un valor presente y desconocido → `{ ok:false }` (fail closed:
 * nunca se lo trata como real).
 */
export function combineLlmModes(claims: readonly unknown[]): { ok: true; mode: LlmMode } | { ok: false; invalid: string } {
  let mode: LlmMode = 'real';
  for (const c of claims) {
    if (c === undefined || c === null) continue;
    if (!isLlmMode(c)) return { ok: false, invalid: String(c).slice(0, 40) };
    if (c === 'mock') mode = 'mock';
    else if (c === 'replay' && mode !== 'mock') mode = 'replay';
  }
  return { ok: true, mode };
}
