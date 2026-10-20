import { Injectable, Logger } from '@nestjs/common';

export interface VideogenVideoPayload {
  title: string;
  content_txt: string;
  chapter_number: number;
  client_reference_id: string;
  tts_voice?: string;
  /** r59: metadata libre que Videogen guarda con el pedido; lee `tts_model` (p.ej. snapshot fijo del TTS). */
  external_metadata?: Record<string, unknown>;
}

export interface VideogenBatchJob {
  job_id: string;
  chapter_number: number;
  status: string;
  client_reference_id?: string | null;
  download_url?: string | null;
  error?: string | null;
  progress?: number | null;
  /**
   * V2.1 (R11a): duración del video en segundos SI Videogen la informa en el
   * status (campo opcional; los consumidores legacy lo ignoran). null/ausente = desconocida.
   */
  duration_seconds?: number | null;
}

export interface VideogenBatchResult {
  batch_id?: string | null;
  jobs: VideogenBatchJob[];
}

export interface VideogenBatchStatus {
  batch_id: string;
  batch_status?: string | null;
  jobs: VideogenBatchJob[];
}

export interface VideogenCostBreakdown {
  job_id: string;
  estimated_total_cost: number;
  breakdown: Record<string, number> | null;
}

const COMPLETED_STATUSES = new Set(['completed', 'done', 'success', 'finished']);
const FAILED_STATUSES    = new Set(['failed', 'error', 'cancelled', 'canceled']);

export function isJobCompleted(status: string): boolean {
  return COMPLETED_STATUSES.has((status ?? '').toLowerCase());
}

export function isJobFailed(status: string): boolean {
  return FAILED_STATUSES.has((status ?? '').toLowerCase());
}

export function isJobPending(status: string): boolean {
  return !isJobCompleted(status) && !isJobFailed(status);
}

/**
 * V2.1 (R11a): duración en SEGUNDOS del status crudo de Videogen, solo desde
 * campos con unidad explícita (`duration_seconds`/`duration_sec`, o
 * `duration_ms` convertido). El genérico `duration` (unidad desconocida) se
 * ignora; el rango plausible lo valida el worker (video-duration.ts).
 */
function videogenDurationSeconds(j: any): number | null {
  for (const k of ['duration_seconds', 'duration_sec']) {
    const n = j?.[k] != null ? Number(j[k]) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  const ms = j?.duration_ms != null ? Number(j.duration_ms) : NaN;
  if (Number.isFinite(ms) && ms > 0) return ms / 1000;
  return null;
}

/**
 * r62 (N2): timeout HTTP OPCIONAL, por llamada, del cliente de Cursia hacia Videogen (Videogen no cambia). Solo lo pasan
 * los llamadores V2 (dynamic-item-worker y el barrido de conciliación), que tratan un POST vencido como envío ambiguo y
 * un GET vencido como error reintentable. SIN la opción, cada método hace exactamente el mismo `fetch` que antes (V1:
 * video-worker.ts no cambia de comportamiento; re-review r62 (a)).
 */
export interface VideogenCallOptions {
  /** Timeout de la llamada (ms). Ausente = sin timeout (comportamiento previo). */
  timeoutMs?: number;
}
/** Defaults de los llamadores V2 (VIDEOGEN_HTTP_TIMEOUT_MS / VIDEOGEN_SUBMIT_TIMEOUT_MS los pisan). */
export const VIDEOGEN_V2_GET_TIMEOUT_MS_DEFAULT = 60_000;
export const VIDEOGEN_V2_SUBMIT_TIMEOUT_MS_DEFAULT = 180_000;
function v2TimeoutFromEnv(key: string, dflt: number, env: Record<string, string | undefined>): number {
  const n = Number(env[key]);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}
/** Opciones de llamada de los llamadores V2. */
export function videogenV2CallOptions(kind: 'get' | 'submit', env: Record<string, string | undefined> = process.env): VideogenCallOptions {
  return kind === 'submit'
    ? { timeoutMs: v2TimeoutFromEnv('VIDEOGEN_SUBMIT_TIMEOUT_MS', VIDEOGEN_V2_SUBMIT_TIMEOUT_MS_DEFAULT, env) }
    : { timeoutMs: v2TimeoutFromEnv('VIDEOGEN_HTTP_TIMEOUT_MS', VIDEOGEN_V2_GET_TIMEOUT_MS_DEFAULT, env) };
}
/** Sin `timeoutMs` → `fetch(url, init)` tal cual (mismos argumentos que antes). Con él → AbortSignal.timeout. */
async function videogenFetch(url: string, init: RequestInit, opts: VideogenCallOptions | undefined, what: string): Promise<Response> {
  const ms = opts?.timeoutMs;
  if (!(typeof ms === 'number' && Number.isFinite(ms) && ms > 0)) return fetch(url, init);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    const name = err instanceof Error ? err.name : 'error';
    throw new Error(`Videogen ${what}: error de red (${name}${name === 'TimeoutError' ? `, ${ms} ms` : ''})`);
  }
}

@Injectable()
export class VideogenService {
  private readonly logger = new Logger(VideogenService.name);

  private getConfig(): { apiKey: string; baseUrl: string } {
    const apiKey = (process.env.VIDEOGEN_API_KEY ?? '').trim();
    const baseUrl = (process.env.VIDEOGEN_API_URL ?? '').replace(/\/$/, '');

    if (!apiKey) throw new Error('VIDEOGEN_API_KEY not configured');
    if (!baseUrl) throw new Error('VIDEOGEN_API_URL not configured');

    return { apiKey, baseUrl };
  }

  private parseJobs(raw: any[]): VideogenBatchJob[] {
    return raw.map((j: any) => ({
      job_id: String(j.job_id ?? j.id ?? ''),
      chapter_number: Number(j.chapter_number ?? j.chapter_num ?? 0),
      status: String(j.status ?? 'queued'),
      client_reference_id: j.client_reference_id ?? null,
      download_url: j.download_url ?? null,
      error: j.error ?? j.error_message ?? null,
      progress: j.progress != null ? Number(j.progress) : null,
      duration_seconds: videogenDurationSeconds(j),
    }));
  }

  async batchCreate(videos: VideogenVideoPayload[], opts?: VideogenCallOptions): Promise<VideogenBatchResult> {
    const { apiKey, baseUrl } = this.getConfig();

    this.logger.log(`Submitting batch-create to Videogen: ${videos.length} videos`);

    const response = await videogenFetch(`${baseUrl}/api/external/videos/batch-create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ videos }),
    }, opts, 'batch-create');

    const text = await response.text();
    this.logger.log(`Videogen batch-create response: HTTP ${response.status}`);

    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Videogen returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      const msg = parsed?.error ?? parsed?.message ?? JSON.stringify(parsed);
      throw new Error(`Videogen batch-create failed (HTTP ${response.status}): ${msg}`);
    }

    const rawJobs: any[] = parsed.jobs ?? parsed.videos ?? [];
    return {
      batch_id: parsed.batch_id ?? null,
      jobs: this.parseJobs(rawJobs),
    };
  }

  async getBatchStatus(batchId: string, opts?: VideogenCallOptions): Promise<VideogenBatchStatus> {
    const { apiKey, baseUrl } = this.getConfig();

    const url = `${baseUrl}/api/external/videos/batches/${encodeURIComponent(batchId)}/status`;
    this.logger.log(`Polling Videogen batch status: ${batchId}`);

    const response = await videogenFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    }, opts, 'batch-status');

    const text = await response.text();
    this.logger.log(`Videogen batch-status response: HTTP ${response.status}`);

    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Videogen returned non-JSON on batch-status (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      const msg = parsed?.error ?? parsed?.message ?? JSON.stringify(parsed);
      throw new Error(`Videogen batch-status failed (HTTP ${response.status}): ${msg}`);
    }

    const rawJobs: any[] = parsed.jobs ?? parsed.videos ?? [];
    return {
      batch_id: batchId,
      batch_status: parsed.status ?? parsed.batch_status ?? null,
      jobs: this.parseJobs(rawJobs),
    };
  }

  async getVideoStatus(jobId: string, opts?: VideogenCallOptions): Promise<VideogenBatchJob> {
    const { apiKey, baseUrl } = this.getConfig();

    const url = `${baseUrl}/api/external/videos/${encodeURIComponent(jobId)}/status`;
    this.logger.log(`Polling Videogen video status: ${jobId}`);

    const response = await videogenFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    }, opts, 'video-status');

    const text = await response.text();

    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Videogen returned non-JSON on video-status (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      const msg = parsed?.error ?? parsed?.message ?? JSON.stringify(parsed);
      throw new Error(`Videogen video-status failed (HTTP ${response.status}): ${msg}`);
    }

    return this.parseJobs([parsed])[0];
  }

  /**
   * r62 (N2): cancelación de un job (`POST /api/videos/{id}/cancel`, endpoint EXISTENTE de Videogen con DualAuthGuard,
   * la misma API key; Videogen no cambia). Solo la usa la conciliación V2 y solo para un job ENCOLADO: Videogen lo saca
   * de la cola y lo marca failed. Para un job que ya está PROCESANDO no lo detiene (el procesador no consulta la
   * cancelación y vuelve a escribir su progreso), así que el llamador nunca lo usa como prueba de que no hay render.
   * `alreadyInactive` = Videogen respondió que el job ya no está activo (400 job_not_active).
   */
  async cancelVideo(jobId: string, opts?: VideogenCallOptions): Promise<{ cancelled: boolean; alreadyInactive: boolean }> {
    const { apiKey, baseUrl } = this.getConfig();
    const url = `${baseUrl}/api/videos/${encodeURIComponent(jobId)}/cancel`;
    this.logger.log(`Cancelling Videogen job: ${jobId}`);
    const response = await videogenFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } }, opts, 'cancel');
    const text = await response.text();
    let parsed: Record<string, any> = {};
    try { parsed = JSON.parse(text); } catch { /* cuerpo no JSON */ }
    if (response.ok) return { cancelled: true, alreadyInactive: false };
    if (response.status === 400 && parsed?.error === 'job_not_active') return { cancelled: false, alreadyInactive: true };
    throw new Error(`Videogen cancel failed (HTTP ${response.status}): ${String(parsed?.error ?? parsed?.message ?? text).slice(0, 200)}`);
  }

  /**
   * Costo real por video, calculado por Videogen a partir de sus logs de uso
   * reales (OpenAI texto/imágenes, voz, render, YouTube) — no una tarifa
   * configurada. Mismo baseUrl/apiKey que el resto de este servicio; el
   * endpoint acepta la misma API key vía DualAuthGuard (confirmado contra
   * el código de video-engine-ia).
   */
  async getVideoCost(jobId: string, opts?: VideogenCallOptions): Promise<VideogenCostBreakdown> {
    const { apiKey, baseUrl } = this.getConfig();

    const url = `${baseUrl}/api/costs/videos/${encodeURIComponent(jobId)}`;
    this.logger.log(`Fetching Videogen real cost: ${jobId}`);

    const response = await videogenFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    }, opts, 'cost');

    const text = await response.text();

    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Videogen returned non-JSON on cost lookup (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      const msg = parsed?.error ?? parsed?.message ?? JSON.stringify(parsed);
      throw new Error(`Videogen cost lookup failed (HTTP ${response.status}): ${msg}`);
    }

    const totalCost = Number(parsed.estimated_total_cost);
    if (!Number.isFinite(totalCost)) {
      throw new Error(`Videogen cost lookup returned invalid estimated_total_cost for job ${jobId}`);
    }

    return { job_id: jobId, estimated_total_cost: totalCost, breakdown: parsed.breakdown ?? null };
  }
}
