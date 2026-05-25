import {
  Body,
  Controller,
  HttpStatus,
  Logger,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { SupabaseJwtGuard } from '../auth/supabase-jwt.guard';

/**
 * Proxy seguro hacia Video Engine IA.
 * Prefijo global: /api/v1/video-engine
 *
 * Reemplaza la Cloudflare Pages Function (functions/api/video-engine.js)
 * para el hosting en VPS donde Cloudflare Workers no están disponibles.
 *
 * Variables de entorno requeridas (Videogen External API):
 *   VIDEOGEN_API_URL  → URL base de Videogen: https://videosb.nomaddi.com
 *   VIDEOGEN_API_KEY  → API key de institución en Videogen (formato veia_live_...)
 *
 * Usa @Res() para pasar la respuesta del Video Engine tal cual,
 * evitando que el ResponseInterceptor global añada un envelope innecesario.
 */
@Controller('video-engine')
export class VideoEngineController {
  private readonly logger = new Logger(VideoEngineController.name);

  @Post()
  @UseGuards(SupabaseJwtGuard)
  async proxyRequest(
    @Body() body: { action: string; payload?: Record<string, unknown> },
    @Res() res: Response,
  ): Promise<void> {
    const veApiKey  = (process.env.VIDEOGEN_API_KEY  ?? '').trim();
    const veBaseUrl = (process.env.VIDEOGEN_API_URL ?? '').replace(/\/$/, '');

    // ── Verificar configuración ──────────────────────────────────────────
    if (!veApiKey) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: 'VIDEOGEN_API_KEY no configurado en el servidor.',
      });
      return;
    }
    if (!veBaseUrl) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: 'VIDEOGEN_API_URL no configurado en el servidor.',
      });
      return;
    }

    const { action, payload } = body;
    if (!action) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'Campo "action" requerido.' });
      return;
    }

    // ── Headers hacia Video Engine ───────────────────────────────────────
    const veHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + veApiKey,
    };

    // ── Rutear acción ────────────────────────────────────────────────────
    let veRes: globalThis.Response;

    try {
      if (action === 'auth-test') {
        veRes = await fetch(`${veBaseUrl}/api/external/auth-test`, {
          method: 'GET',
          headers: veHeaders,
        });

      } else if (action === 'batch-create') {
        // ── dry-run: no encolar jobs ni llamar Videogen ─────────────────
        const isDryRun = payload?.['dryRun'] === true || payload?.['dry_run'] === true;
        if (isDryRun) {
          const videos = (payload?.['videos'] as unknown[]) ?? [];
          const dryBatchId = 'dry_batch_' + Date.now();
          const dryJobs = videos.map((v: unknown, idx: number) => {
            const vObj = v as Record<string, unknown>;
            const capNum = vObj['chapter_number'] ?? (idx + 1);
            const jobId  = 'dry_job_cap' + capNum + '_' + Date.now();
            return {
              job_id:          jobId,
              chapter_number:  capNum,
              status:          'completed_local',
              download_url:    `${veBaseUrl}/dry-run/cap${capNum}.mp4`,
              client_reference_id: vObj['client_reference_id'] ?? null,
            };
          });

          this.logger.log(
            `[VideoEngine][DRY-RUN] batch-create simulado — ${dryJobs.length} jobs`,
          );
          res.status(HttpStatus.OK).json({
            dry_run:   true,
            batch_id:  dryBatchId,
            status:    'completed_local',
            jobs:      dryJobs,
            videos:    dryJobs,  // alias — algunos parsers usan 'videos'
            message:   'dry-run: batch simulado, no se encolan jobs ni se llama Videogen.',
          });
          return;
        }

        veRes = await fetch(`${veBaseUrl}/api/external/videos/batch-create`, {
          method: 'POST',
          headers: veHeaders,
          body: JSON.stringify(payload ?? {}),
        });

      } else if (action === 'create') {
        // ── dry-run individual ──────────────────────────────────────────
        const isDryRunCreate = payload?.['dryRun'] === true || payload?.['dry_run'] === true;
        if (isDryRunCreate) {
          const capNum  = payload?.['chapter_number'] ?? 1;
          const dryJobId = 'dry_job_cap' + capNum + '_' + Date.now();
          this.logger.log(`[VideoEngine][DRY-RUN] create simulado cap=${capNum}`);
          res.status(HttpStatus.OK).json({
            dry_run:         true,
            job_id:          dryJobId,
            status:          'completed_local',
            chapter_number:  capNum,
            download_url:    `${veBaseUrl}/dry-run/cap${capNum}.mp4`,
            message:         'dry-run: job simulado, sin FFmpeg ni proveedor.',
          });
          return;
        }

        veRes = await fetch(`${veBaseUrl}/api/external/videos/create`, {
          method: 'POST',
          headers: veHeaders,
          body: JSON.stringify(payload ?? {}),
        });

      } else if (action === 'status') {
        const jobId = payload?.job_id;
        if (!jobId) {
          res.status(HttpStatus.BAD_REQUEST).json({
            error: 'payload.job_id requerido para action=status.',
          });
          return;
        }
        veRes = await fetch(
          `${veBaseUrl}/api/external/videos/${encodeURIComponent(String(jobId))}/status`,
          { method: 'GET', headers: veHeaders },
        );

      } else if (action === 'batch-status') {
        const batchId = payload?.batch_id;
        if (!batchId) {
          res.status(HttpStatus.BAD_REQUEST).json({
            error: 'payload.batch_id requerido para action=batch-status.',
          });
          return;
        }
        veRes = await fetch(
          `${veBaseUrl}/api/external/videos/batches/${encodeURIComponent(String(batchId))}/status`,
          { method: 'GET', headers: veHeaders },
        );

      } else {
        res.status(HttpStatus.BAD_REQUEST).json({ error: 'Acción desconocida: ' + action });
        return;
      }

    } catch (e) {
      const msg = (e as Error).message ?? 'Error de red';
      this.logger.error(`Video Engine network error [${action}]: ${msg}`);
      res.status(HttpStatus.BAD_GATEWAY).json({
        error: 'Error de red hacia Video Engine: ' + msg,
      });
      return;
    }

    // ── Pasar respuesta de Video Engine tal cual ─────────────────────────
    const text = await veRes.text();
    this.logger.log(`Video Engine [${action}] → HTTP ${veRes.status}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    res.status(veRes.status).json(parsed);
  }
}
