import { Injectable, Logger } from '@nestjs/common';

export interface VideogenVideoPayload {
  title: string;
  content_txt: string;
  chapter_number: number;
  client_reference_id: string;
  tts_voice?: string;
}

export interface VideogenBatchJob {
  job_id: string;
  chapter_number: number;
  status: string;
  client_reference_id?: string | null;
  download_url?: string | null;
  error?: string | null;
  progress?: number | null;
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
    }));
  }

  async batchCreate(videos: VideogenVideoPayload[]): Promise<VideogenBatchResult> {
    const { apiKey, baseUrl } = this.getConfig();

    this.logger.log(`Submitting batch-create to Videogen: ${videos.length} videos`);

    const response = await fetch(`${baseUrl}/api/external/videos/batch-create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ videos }),
    });

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

  async getBatchStatus(batchId: string): Promise<VideogenBatchStatus> {
    const { apiKey, baseUrl } = this.getConfig();

    const url = `${baseUrl}/api/external/videos/batches/${encodeURIComponent(batchId)}/status`;
    this.logger.log(`Polling Videogen batch status: ${batchId}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });

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

  async getVideoStatus(jobId: string): Promise<VideogenBatchJob> {
    const { apiKey, baseUrl } = this.getConfig();

    const url = `${baseUrl}/api/external/videos/${encodeURIComponent(jobId)}/status`;
    this.logger.log(`Polling Videogen video status: ${jobId}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });

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
   * Costo real por video, calculado por Videogen a partir de sus logs de uso
   * reales (OpenAI texto/imágenes, voz, render, YouTube) — no una tarifa
   * configurada. Mismo baseUrl/apiKey que el resto de este servicio; el
   * endpoint acepta la misma API key vía DualAuthGuard (confirmado contra
   * el código de video-engine-ia).
   */
  async getVideoCost(jobId: string): Promise<VideogenCostBreakdown> {
    const { apiKey, baseUrl } = this.getConfig();

    const url = `${baseUrl}/api/costs/videos/${encodeURIComponent(jobId)}`;
    this.logger.log(`Fetching Videogen real cost: ${jobId}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });

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
