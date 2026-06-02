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
  client_reference_id?: string;
  download_url?: string;
}

export interface VideogenBatchResult {
  batch_id?: string;
  jobs: VideogenBatchJob[];
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

  async batchCreate(videos: VideogenVideoPayload[]): Promise<VideogenBatchResult> {
    const { apiKey, baseUrl } = this.getConfig();

    const body = JSON.stringify({ videos });
    this.logger.log(`Submitting batch-create to Videogen: ${videos.length} videos`);

    const response = await fetch(`${baseUrl}/api/external/videos/batch-create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
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
    const jobs: VideogenBatchJob[] = rawJobs.map((j: any) => ({
      job_id: String(j.job_id ?? j.id ?? ''),
      chapter_number: Number(j.chapter_number ?? j.chapter_num ?? 0),
      status: String(j.status ?? 'queued'),
      client_reference_id: j.client_reference_id ?? null,
      download_url: j.download_url ?? null,
    }));

    return {
      batch_id: parsed.batch_id ?? null,
      jobs,
    };
  }
}
