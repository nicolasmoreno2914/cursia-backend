/**
 * Brand Extraction Worker
 *
 * Procesa jobs `execution_mode='brand_extraction'`: descarga el PDF del
 * manual de marca (artifact en Supabase Storage), lo analiza con Claude
 * y deja el BrandProfile en `pending_review` para confirmación humana.
 *
 * Ejecutar: npx ts-node src/workers/brand-extraction-worker.ts
 * Env: ANTHROPIC_API_KEY (requerido), BRAND_WORKER_POLL_MS (default 5000)
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { BrandExtractionService } from '../modules/brand-profiles/brand-extraction.service';
import { BrandProfile } from '../modules/brand-profiles/entities/brand-profile.entity';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveInt(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

interface ClaimedJob {
  id: string;
  input_payload: {
    brandProfileId: string;
    institutionId: string;
    sourceArtifactId: string;
    ownerId: string;
  };
}

async function claimNextJob(
  dataSource: DataSource,
  workerId: string,
  leaseSeconds: number,
): Promise<ClaimedJob | null> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  try {
    const candidates = await queryRunner.query(
      `SELECT id FROM production_jobs WHERE execution_mode = 'brand_extraction'
       AND worker_status IN ('queued','retrying')
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       AND (lease_until IS NULL OR lease_until < NOW())
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!Array.isArray(candidates) || candidates.length === 0) {
      await queryRunner.commitTransaction();
      return null;
    }
    const jobId = candidates[0].id;
    await queryRunner.query(
      `UPDATE production_jobs SET worker_status='running', status='running',
       current_step='brand_extraction', worker_id=$1, claimed_at=NOW(),
       lease_until=NOW()+($2*INTERVAL '1 second'),
       attempt_count=COALESCE(attempt_count,0)+1,
       started_at=COALESCE(started_at,NOW()), updated_at=NOW()
       WHERE id=$3`,
      [workerId, leaseSeconds, jobId],
    );
    await queryRunner.commitTransaction();
    const rows = await dataSource.query(
      `SELECT id, input_payload FROM production_jobs WHERE id=$1`,
      [jobId],
    );
    return rows[0] || null;
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function finishJob(
  dataSource: DataSource,
  jobId: string,
  ok: boolean,
  summaryOrError: Record<string, any> | string,
): Promise<void> {
  if (ok) {
    await dataSource.query(
      `UPDATE production_jobs SET worker_status='done', status='done', progress=100,
       finished_at=NOW(), updated_at=NOW(), output_summary=$1 WHERE id=$2`,
      [JSON.stringify(summaryOrError), jobId],
    );
  } else {
    await dataSource.query(
      `UPDATE production_jobs SET worker_status='failed', status='failed',
       error_message=$1, error_step='brand_extraction', finished_at=NOW(), updated_at=NOW()
       WHERE id=$2`,
      [String(summaryOrError).slice(0, 2000), jobId],
    );
  }
}

async function downloadPdf(
  artifactsService: ArtifactsService,
  artifactId: string,
  ownerId: string,
): Promise<Buffer> {
  const info = await artifactsService.getDownloadUrl(artifactId, ownerId, 600);
  if (!info.url) {
    throw new Error(
      'No se pudo generar la URL de descarga del PDF (falta SUPABASE_SERVICE_ROLE_KEY)',
    );
  }
  const response = await fetch(info.url);
  if (!response.ok) {
    throw new Error(`Descarga del PDF falló: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function processJob(
  logger: Logger,
  dataSource: DataSource,
  artifactsService: ArtifactsService,
  extractionService: BrandExtractionService,
  job: ClaimedJob,
): Promise<void> {
  const { brandProfileId, sourceArtifactId, ownerId } = job.input_payload;
  const profileRepo = dataSource.getRepository(BrandProfile);
  const profile = await profileRepo.findOne({ where: { id: brandProfileId } });
  if (!profile) throw new Error(`BrandProfile ${brandProfileId} no existe`);

  logger.log(`Descargando PDF (artifact ${sourceArtifactId})…`);
  const pdf = await downloadPdf(artifactsService, sourceArtifactId, ownerId);
  logger.log(`PDF descargado (${(pdf.length / 1024).toFixed(0)} KB). Extrayendo con Claude…`);

  const extracted = await extractionService.extractFromPdf(pdf);

  profile.palette = {
    ...profile.palette,
    ...extracted.colors,
  };
  profile.typography = extracted.typography;
  profile.usageRules = extracted.usageRules;
  profile.extractedRaw = { ...extracted.raw, warnings: extracted.warnings };
  profile.status = 'pending_review';
  await profileRepo.save(profile);

  logger.log(
    `BrandProfile ${brandProfileId} → pending_review (${extracted.warnings.length} warnings)`,
  );
}

async function main(): Promise<void> {
  const logger = new Logger('BrandExtractionWorker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const dataSource = app.get(DataSource);
  const artifactsService = app.get(ArtifactsService);
  const extractionService = app.get(BrandExtractionService);

  const workerId = `brand-worker-${randomUUID().slice(0, 8)}`;
  const pollMs = readPositiveInt('BRAND_WORKER_POLL_MS', 5000);
  const leaseSeconds = readPositiveInt('BRAND_WORKER_LEASE_S', 300);

  let shuttingDown = false;
  process.on('SIGINT', () => { shuttingDown = true; });
  process.on('SIGTERM', () => { shuttingDown = true; });

  logger.log(`Brand extraction worker started (workerId=${workerId}, pollMs=${pollMs})`);

  while (!shuttingDown) {
    try {
      const job = await claimNextJob(dataSource, workerId, leaseSeconds);
      if (job) {
        logger.log(`Job ${job.id} reclamado`);
        try {
          await processJob(logger, dataSource, artifactsService, extractionService, job);
          await finishJob(dataSource, job.id, true, {
            brandProfileId: job.input_payload.brandProfileId,
            status: 'pending_review',
          });
        } catch (err: any) {
          logger.error(`Job ${job.id} falló: ${err?.message || err}`);
          await finishJob(dataSource, job.id, false, err?.message || String(err));
          // Marcar el perfil como draft con el error registrado (no archived: el usuario puede reintentar)
          try {
            await dataSource.query(
              `UPDATE brand_profiles SET extracted_raw = jsonb_build_object('error', $1::text), updated_at=NOW()
               WHERE id=$2 AND status='draft'`,
              [String(err?.message || err).slice(0, 500), job.input_payload.brandProfileId],
            );
          } catch {}
        }
      }
    } catch (err: any) {
      logger.error(`Error en el loop del worker: ${err?.message || err}`);
    }
    await sleep(pollMs);
  }

  logger.log('Shutting down…');
  await app.close();
}

main().catch((err) => {
  console.error('Brand extraction worker crashed:', err);
  process.exit(1);
});
