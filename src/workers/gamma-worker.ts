import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { Artifact } from '../modules/artifacts/entities/artifact.entity';
import {
  GammaWorkerProgressSummary,
  ProductionJobsService,
} from '../modules/production-jobs/production-jobs.service';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';
import { EventsService } from '../events/events.service';
import { assertGammaThemesConfigured, resolveGammaThemeId } from '../config/gamma-themes.config';
import { PDFParse } from 'pdf-parse';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

const GAMMA_API_BASE = 'https://public-api.gamma.app/v1.0';
const NUM_CARDS = 10;
const PART_A_PAGE = 1; // 1-indexed
const PART_B_PAGE = 6; // 1-indexed
const MAX_GENERATION_ATTEMPTS = 3;
const GENERATION_POLL_MS = 6000;
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min por capítulo

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveInt(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function isTrueEnv(envKey: string): boolean {
  return String(process.env[envKey] || '').toLowerCase() === 'true';
}

function buildEffectiveCourseId(job: ProductionJob): string {
  if (job.frontendCourseId) return String(job.frontendCourseId);
  if (job.courseId !== null && job.courseId !== undefined) return String(job.courseId);
  return 'unknown-course';
}

function cleanText(raw: string): string {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

type ChapterInfo = { n: number; title: string; text: string };

function buildChapters(contentSnapshot: Record<string, any>, inputCourseData: Record<string, any>): ChapterInfo[] {
  const D = (contentSnapshot.D ?? {}) as Record<string, any>;
  const F = (contentSnapshot.F ?? {}) as Record<string, string>;
  const sourceCaps = Array.isArray(D.caps) ? D.caps : Array.isArray(inputCourseData.caps) ? inputCourseData.caps : [];
  const chapters: ChapterInfo[] = [];

  for (let i = 0; i < sourceCaps.length; i += 1) {
    const cap = sourceCaps[i];
    const capNum = Number(cap?.n ?? i + 1);
    const title = String(cap?.t ?? cap?.title ?? cap?.name ?? `Capítulo ${capNum}`);
    const rawText = String(F[`libro_cap${capNum}.md`] ?? F[`cap${capNum}_base.html`] ?? '');
    chapters.push({ n: capNum, title, text: cleanText(rawText) });
  }

  if (chapters.length === 0) {
    for (const [filename, content] of Object.entries(F)) {
      const match = filename.match(/^libro_cap(\d+)\.md$/);
      if (!match) continue;
      const capNum = Number(match[1]);
      chapters.push({ n: capNum, title: `Capítulo ${capNum}`, text: cleanText(String(content)) });
    }
    chapters.sort((a, b) => a.n - b.n);
  }

  return chapters.filter((c) => c.text.length > 0);
}

async function downloadArtifactJson(
  artifactsService: ArtifactsService,
  ownerId: string,
  artifactId: string,
  logger: Logger,
): Promise<Record<string, any> | null> {
  try {
    const urlRes = await artifactsService.getDownloadUrl(artifactId, ownerId, 3600);
    const url = urlRes.url;
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`[GammaWorker] Artifact ${artifactId} HTTP ${res.status}`);
      return null;
    }
    return res.json() as Promise<Record<string, any>>;
  } catch (e) {
    logger.warn(`[GammaWorker] Artifact ${artifactId} error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function findExistingGammaArtifact(
  artifactsService: ArtifactsService,
  ownerId: string,
  courseId: string,
): Promise<Artifact | null> {
  try {
    const list = await artifactsService.findAll(ownerId, { courseId, type: 'gamma_snapshot' });
    if (!list?.length) return null;
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const candidate = list[0];
    if (candidate.sizeBytes !== null && candidate.sizeBytes <= 0) return null;
    return candidate;
  } catch {
    return null;
  }
}

// ── Llamada a la API de Gamma ───────────────────────────────────────────────

interface GammaGenerationResult {
  gammaId: string;
  gammaUrl: string;
  embedUrl: string;
  viewUrl: string;
  exportUrl: string;
}

async function createGammaGeneration(chapter: ChapterInfo, themeId: string, apiKey: string): Promise<string> {
  const additionalInstructions =
    "La diapositiva 1 debe funcionar como portada e incluir el texto 'PARTE A'. " +
    "La diapositiva 6 debe marcar el inicio de la segunda mitad e incluir el texto 'PARTE B'. " +
    'Dividí el contenido en dos bloques temáticos coherentes: diapositivas 1-5 (Parte A) y 6-10 (Parte B).';

  const body = {
    inputText: chapter.text,
    textMode: 'generate',
    format: 'presentation',
    numCards: NUM_CARDS,
    additionalInstructions,
    cardOptions: {
      dimensions: '16x9',
      headerFooter: {
        bottomRight: { type: 'image', source: 'themeLogo', size: 'sm' },
      },
    },
    textOptions: { amount: 'brief' },
    sharingOptions: { externalAccess: 'view' },
    themeId,
    exportAs: 'pdf',
  };

  const res = await fetch(`${GAMMA_API_BASE}/generations`, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new GammaNonRetryableError(`Gamma API auth error (${res.status}) — verificar GAMMA_API_KEY/plan Pro: ${errText}`);
    }
    if (res.status === 429) {
      throw new GammaRetryableError(`Gamma API rate limit (429): ${errText}`);
    }
    throw new GammaRetryableError(`Gamma API error (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { generationId?: string };
  if (!data.generationId) throw new GammaRetryableError('Gamma API no devolvió generationId');
  return data.generationId;
}

async function pollGammaGeneration(generationId: string, apiKey: string, logger: Logger): Promise<GammaGenerationResult> {
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await fetch(`${GAMMA_API_BASE}/generations/${generationId}`, {
      headers: { 'X-API-KEY': apiKey },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new GammaRetryableError(`Gamma polling error (${res.status}): ${errText}`);
    }
    const data = (await res.json()) as {
      status: string;
      gammaId?: string;
      gammaUrl?: string;
      exportUrl?: string;
    };

    if (data.status === 'completed') {
      const gammaId = data.gammaId ?? '';
      const gammaUrl = data.gammaUrl ?? '';
      const docId = gammaUrl.split('/docs/')[1] ?? gammaId;
      return {
        gammaId,
        gammaUrl,
        embedUrl: `https://gamma.app/embed/${docId}`,
        viewUrl: `${gammaUrl}?mode=present`,
        exportUrl: data.exportUrl ?? '',
      };
    }
    if (data.status === 'failed') {
      throw new GammaRetryableError(`Gamma generation ${generationId} failed`);
    }

    logger.log(`[GammaWorker] generation ${generationId} status=${data.status} — esperando…`);
    await sleep(GENERATION_POLL_MS);
  }

  throw new GammaRetryableError(`Gamma generation ${generationId} excedió el timeout de ${GENERATION_TIMEOUT_MS / 1000}s`);
}

class GammaRetryableError extends Error {}
class GammaNonRetryableError extends Error {}

/** Descarga el PDF y valida: exactamente 10 páginas, "PARTE A" en pág 1, "PARTE B" en pág 6. */
async function downloadAndValidatePdf(exportUrl: string): Promise<{ buffer: Buffer; pageCount: number }> {
  if (!exportUrl) throw new GammaRetryableError('Gamma no devolvió exportUrl del PDF');
  const res = await fetch(exportUrl);
  if (!res.ok) throw new GammaRetryableError(`No se pudo descargar el PDF (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const parser = new PDFParse({ data: buffer });
  let pageCount: number;
  let pageText: (num: number) => string;
  try {
    const textResult = await parser.getText();
    pageCount = textResult.total;
    pageText = (num: number) => textResult.pages.find((p) => p.num === num)?.text ?? '';
  } finally {
    await parser.destroy();
  }

  if (pageCount !== NUM_CARDS) {
    throw new GammaRetryableError(`El PDF tiene ${pageCount} páginas, se esperaban ${NUM_CARDS}`);
  }
  const partAText = pageText(PART_A_PAGE).toUpperCase();
  const partBText = pageText(PART_B_PAGE).toUpperCase();
  if (!partAText.includes('PARTE A')) {
    throw new GammaRetryableError(`La diapositiva ${PART_A_PAGE} no contiene "PARTE A"`);
  }
  if (!partBText.includes('PARTE B')) {
    throw new GammaRetryableError(`La diapositiva ${PART_B_PAGE} no contiene "PARTE B"`);
  }

  return { buffer, pageCount };
}

// ── Render de la portada (página 1 del PDF) a imagen ─────────────────────────
// Usa pdftoppm (poppler-utils, ya instalado en el VPS vía deploy.yml) para no
// depender de un iframe en vivo de gamma.app en el paquete final: si Gamma cae
// o el usuario borra la presentación en su cuenta, la portada ya embebida en
// el .mbz sigue funcionando. Best-effort: si falla, el label queda sin imagen
// pero el botón "Ver presentación completa" (el PDF adjunto) sigue intacto.
async function renderPdfFirstPageToPng(pdfBuffer: Buffer, logger: Logger): Promise<Buffer | null> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'gamma-cover-'));
    const pdfPath = join(dir, 'in.pdf');
    const outPrefix = join(dir, 'out');
    await writeFile(pdfPath, pdfBuffer);
    await execFileAsync('pdftoppm', ['-png', '-f', '1', '-l', '1', '-r', '150', pdfPath, outPrefix]);
    // pdftoppm nombra el archivo con el número de página con padding variable
    // (ej. "out-01.png", no necesariamente "out-1.png") — buscamos el .png real
    // en vez de asumir el sufijo exacto.
    const files = await readdir(dir);
    const pngName = files.find((f) => f.endsWith('.png'));
    if (!pngName) throw new Error('pdftoppm no generó ningún archivo .png');
    return await readFile(join(dir, pngName));
  } catch (e) {
    logger.warn(`[GammaWorker] No se pudo renderizar la portada del PDF (no bloqueante): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Handler principal ────────────────────────────────────────────────────────

async function generateChapterWithRetries(
  chapter: ChapterInfo,
  themeId: string,
  apiKey: string,
  logger: Logger,
): Promise<{ gammaId: string; gammaUrl: string; embedUrl: string; viewUrl: string; pdfBuffer: Buffer; pageCount: number }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
    try {
      const generationId = await createGammaGeneration(chapter, themeId, apiKey);
      const result = await pollGammaGeneration(generationId, apiKey, logger);
      const { buffer, pageCount } = await downloadAndValidatePdf(result.exportUrl);
      return {
        gammaId: result.gammaId,
        gammaUrl: result.gammaUrl,
        embedUrl: result.embedUrl,
        viewUrl: result.viewUrl,
        pdfBuffer: buffer,
        pageCount,
      };
    } catch (e) {
      if (e instanceof GammaNonRetryableError) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      logger.warn(`[GammaWorker] Cap ${chapter.n} intento ${attempt}/${MAX_GENERATION_ATTEMPTS} falló: ${lastError.message}`);
      if (attempt < MAX_GENERATION_ATTEMPTS) await sleep(2000 * attempt);
    }
  }

  throw lastError ?? new Error(`Generación del capítulo ${chapter.n} falló sin detalle`);
}

async function handleJob(
  job: ProductionJob,
  jobsService: ProductionJobsService,
  artifactsService: ArtifactsService,
  eventsService: EventsService,
  workerId: string,
  leaseSeconds: number,
  heartbeatMs: number,
  apiKey: string,
  logger: Logger,
): Promise<void> {
  const jobId = job.id;
  const payload = (job.inputPayload ?? {}) as Record<string, any>;
  const courseId = buildEffectiveCourseId(job);
  const courseTitle = String(payload.courseTitle ?? payload.courseData?.nombre ?? 'Curso Cursia');
  const options = (payload.options ?? {}) as Record<string, any>;
  const paletteId = String(payload.paletteId ?? payload.courseData?.pal?.id ?? 'navy-teal');
  const parentJobId = payload?.metadata?.parentJobId ?? null;

  let leaseLost = false;
  let finalized = false;

  const sendHeartbeat = async () => {
    if (finalized || leaseLost) return;
    try {
      const ok = await jobsService.heartbeatWorkerJob(jobId, workerId, leaseSeconds);
      if (!ok) {
        leaseLost = true;
        logger.warn(`[GammaWorker] Lease lost for job ${jobId}`);
      }
    } catch {
      leaseLost = true;
    }
  };
  const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, heartbeatMs);

  const updateProgress = async (
    phase: GammaWorkerProgressSummary['phase'],
    message: string,
    extra?: Partial<GammaWorkerProgressSummary>,
  ) => {
    if (leaseLost) return;
    await jobsService.updateGammaWorkerProgress(jobId, workerId, {
      phase,
      message,
      ...extra,
    }).catch(() => {});
  };

  const trackEvent = async (eventType: string, extra: Record<string, any> = {}) =>
    eventsService.trackBackendEvent({
      userId: job.ownerId,
      eventType,
      courseId,
      jobId,
      parentJobId,
      component: 'gamma',
      provider: 'gamma',
      model: 'gamma-generations-v1',
      mode: 'real',
      costType: extra.costType ?? 'unknown',
      estimatedCostUsd: extra.estimatedCostUsd,
      costSource: extra.costSource ?? 'not_tracked',
      units: extra.units,
      unitType: extra.unitType,
      failed: extra.failed ?? false,
      errorMessage: extra.errorMessage ?? null,
      metadata: {
        workerId,
        courseTitle,
        ...extra.metadata,
      },
    });

  try {
    const marked = await jobsService.markGammaWorkerRunning(jobId, workerId);
    if (!marked) return;
    await trackEvent('gamma_generation_started', { units: 1, unitType: 'per_operation' });

    await sendHeartbeat();
    if (leaseLost) return;

    let existingSnapshot: Record<string, any> = {};
    if (options.restoreFirst !== false) {
      await updateProgress('checking_existing_gamma', 'Verificando presentaciones existentes…');
      const existingArtifact = await findExistingGammaArtifact(artifactsService, job.ownerId, courseId);
      if (existingArtifact) {
        const data = await downloadArtifactJson(artifactsService, job.ownerId, existingArtifact.id, logger);
        if (data?.GAMMA_SNAPSHOT) existingSnapshot = data.GAMMA_SNAPSHOT as Record<string, any>;
      }
    }

    await updateProgress('reading_course_content', 'Leyendo contenido del curso…');
    const contentSnapshotId = String(payload.contentSnapshotArtifactId ?? '').trim();
    if (!contentSnapshotId) throw new Error('Falta la copia del contenido para generar presentaciones');
    const contentSnapshot = await downloadArtifactJson(artifactsService, job.ownerId, contentSnapshotId, logger);
    if (!contentSnapshot?.D || !contentSnapshot?.F) throw new Error('No se pudo leer el contenido del curso');

    let chapters = buildChapters(contentSnapshot, payload.courseData ?? {});
    if (chapters.length === 0) throw new Error('No se encontraron capítulos para generar presentaciones');

    // Válvula de seguridad/testing — el orquestador normal NUNCA setea esto, procesa los 9 capítulos.
    const maxChapters = Number(options.maxChapters ?? 0);
    if (maxChapters > 0) chapters = chapters.slice(0, maxChapters);

    const themeId = resolveGammaThemeId(paletteId);

    await sendHeartbeat();
    if (leaseLost) return;

    const gammaSnapshotEntries: Record<number, any> = { ...existingSnapshot };
    let chaptersCompleted = Object.values(gammaSnapshotEntries).filter((e: any) => e?.status === 'completed').length;
    const chaptersTotal = chapters.length;

    for (const chapter of chapters) {
      if (leaseLost) return;

      const existing = gammaSnapshotEntries[chapter.n];
      if (existing?.status === 'completed') {
        logger.log(`[GammaWorker] Cap ${chapter.n} ya generado — saltando`);
        continue;
      }

      await updateProgress('generating_chapter', `Generando presentación — capítulo ${chapter.n}/${chaptersTotal}…`, {
        chaptersCompleted,
        chaptersTotal,
        currentChapter: chapter.n,
      });

      const generated = await generateChapterWithRetries(chapter, themeId, apiKey, logger);

      // Subir el PDF del capítulo (binario)
      const pdfFilename = `cap${chapter.n}_presentacion.pdf`;
      const pdfStoragePath = `${job.ownerId}/${courseId}/gamma/${pdfFilename}`;
      let pdfArtifactId: string | null = null;
      let pdfStatus: 'ok' | 'failed' = 'ok';
      try {
        const pdfArtifact = await artifactsService.uploadBufferArtifact({
          ownerId: job.ownerId,
          courseId,
          jobId,
          type: 'gamma_pdf',
          filename: pdfFilename,
          storagePath: pdfStoragePath,
          buffer: generated.pdfBuffer,
          mimeType: 'application/pdf',
          metadata: { chapter: chapter.n },
        });
        pdfArtifactId = pdfArtifact.id;
      } catch (e) {
        // Degradación elegante: el deck es lo obligatorio, el PDF adjunto es best-effort.
        pdfStatus = 'failed';
        logger.warn(`[GammaWorker] Cap ${chapter.n}: falló subida de PDF (no bloqueante): ${e instanceof Error ? e.message : String(e)}`);
      }

      // Portada (página 1 del PDF) como imagen — reemplaza al iframe en vivo de
      // gamma.app en el paquete final, para no depender de que Gamma siga
      // disponible. Best-effort: si falla, el label simplemente no tendrá imagen.
      let slideImageArtifactId: string | null = null;
      const coverPng = await renderPdfFirstPageToPng(generated.pdfBuffer, logger);
      if (coverPng) {
        try {
          const coverFilename = `cap${chapter.n}_portada.png`;
          const coverArtifact = await artifactsService.uploadBufferArtifact({
            ownerId: job.ownerId,
            courseId,
            jobId,
            type: 'gamma_slide_image',
            filename: coverFilename,
            storagePath: `${job.ownerId}/${courseId}/gamma/${coverFilename}`,
            buffer: coverPng,
            mimeType: 'image/png',
            metadata: { chapter: chapter.n },
          });
          slideImageArtifactId = coverArtifact.id;
        } catch (e) {
          logger.warn(`[GammaWorker] Cap ${chapter.n}: falló subida de portada (no bloqueante): ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      gammaSnapshotEntries[chapter.n] = {
        generationId: generated.gammaId,
        docSlug: generated.gammaUrl.split('/docs/')[1] ?? '',
        embedUrl: generated.embedUrl,
        viewUrl: generated.viewUrl,
        cardCount: generated.pageCount,
        pdfArtifactId,
        pdfStatus,
        slideImageArtifactId,
        status: 'completed',
        generatedAt: new Date().toISOString(),
      };
      chaptersCompleted += 1;

      // Progreso incremental: re-subir el snapshot tras CADA capítulo, no perder trabajo si el worker reinicia.
      await uploadSnapshot(artifactsService, job.ownerId, courseId, jobId, courseTitle, gammaSnapshotEntries);

      await updateProgress('generating_chapter', `Presentación lista — capítulo ${chapter.n}/${chaptersTotal}`, {
        chaptersCompleted,
        chaptersTotal,
      });

      await sendHeartbeat();
    }

    if (leaseLost) return;

    await updateProgress('uploading_gamma_snapshot', 'Guardando presentaciones…', {
      chaptersCompleted,
      chaptersTotal,
    });

    const finalArtifact = await uploadSnapshot(artifactsService, job.ownerId, courseId, jobId, courseTitle, gammaSnapshotEntries);
    if (leaseLost) return;

    finalized = true;
    await jobsService.completeGammaWorkerJob(jobId, workerId, {
      gammaSnapshotArtifactId: finalArtifact.id,
      artifactIds: { gammaSnapshot: finalArtifact.id },
      chaptersCompleted,
      chaptersTotal,
    });
    await trackEvent('gamma_generation_completed', {
      units: chaptersCompleted,
      unitType: 'per_operation',
      metadata: { chaptersCompleted, chaptersTotal, artifactId: finalArtifact.id },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = !(error instanceof GammaNonRetryableError);
    if (!leaseLost) {
      await jobsService.failGammaWorkerJob(jobId, workerId, message, retryable);
      await trackEvent('gamma_generation_failed', {
        failed: true,
        errorMessage: message,
        units: 1,
        unitType: 'per_operation',
      });
      logger.error(`[GammaWorker] Job ${jobId} failed: ${message}`);
    }
  } finally {
    finalized = true;
    clearInterval(heartbeatTimer);
  }
}

async function uploadSnapshot(
  artifactsService: ArtifactsService,
  ownerId: string,
  courseId: string,
  jobId: string,
  courseTitle: string,
  gammaSnapshotEntries: Record<number, any>,
): Promise<Artifact> {
  const generatedAt = new Date().toISOString();
  const snapshot = {
    type: 'gamma_snapshot',
    schemaVersion: '1.0',
    generatedAt,
    course: { id: courseId, name: courseTitle },
    GAMMA_SNAPSHOT: gammaSnapshotEntries,
    metadata: {
      source: 'backend_gamma',
      chapterCount: Object.keys(gammaSnapshotEntries).length,
      generatedAt,
    },
  };

  const filename = `gamma_snapshot_${courseId}.json`;
  const storagePath = `${ownerId}/${courseId}/gamma/${filename}`;
  return artifactsService.uploadJsonArtifact({
    ownerId,
    courseId,
    jobId,
    type: 'gamma_snapshot',
    filename,
    storagePath,
    payload: snapshot,
    mimeType: 'application/json',
    metadata: {
      generatedBy: 'backend_gamma',
      chapterCount: Object.keys(gammaSnapshotEntries).length,
      createdAt: generatedAt,
    },
  });
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  const logger = new Logger('GammaWorker');

  const apiKey = String(process.env.GAMMA_API_KEY ?? '').trim();
  if (!apiKey) {
    logger.error('GAMMA_API_KEY no está configurado — abortando arranque del worker');
    process.exit(1);
  }

  const dryRun = isTrueEnv('GAMMA_WORKER_DRY_RUN');
  if (!dryRun) {
    try {
      assertGammaThemesConfigured();
    } catch (e) {
      logger.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });

  const jobsService = app.get(ProductionJobsService);
  const artifactsService = app.get(ArtifactsService);
  const eventsService = app.get(EventsService);
  const workerId = process.env.GAMMA_WORKER_ID || `gamma-worker-${process.pid}`;
  const pollMs = readPositiveInt('GAMMA_WORKER_POLL_MS', 5000);
  const leaseSeconds = readPositiveInt('GAMMA_WORKER_LEASE_SECONDS', 300);
  const heartbeatMs = readPositiveInt('GAMMA_WORKER_HEARTBEAT_MS', 20000);

  let shuttingDown = false;
  let idlePolls = 0;
  const activeJobs = new Set<Promise<void>>();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`Received ${signal}; waiting for ${activeJobs.size} active job(s)`);
    await Promise.allSettled(Array.from(activeJobs));
    await app.close();
    logger.log('Gamma worker stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.log(`Gamma worker started (workerId=${workerId}, pollMs=${pollMs}, dryRun=${dryRun})`);

  while (!shuttingDown) {
    const claimed = await jobsService.claimNextBackendGammaJob(workerId, leaseSeconds);
    if (!claimed) {
      idlePolls += 1;
      if (idlePolls % 12 === 0) logger.log(`Idle polling… (${idlePolls})`);
      await sleep(pollMs);
      continue;
    }

    idlePolls = 0;

    if (dryRun) {
      logger.log(`[GammaWorker] Dry-run: simulando job ${claimed.id}`);
      await sleep(1500);
      await jobsService.completeGammaWorkerJob(claimed.id, workerId, {
        gammaSnapshotArtifactId: null,
        dryRun: true,
        chaptersCompleted: 0,
        chaptersTotal: 0,
      });
      continue;
    }

    const promise = handleJob(
      claimed,
      jobsService,
      artifactsService,
      eventsService,
      workerId,
      leaseSeconds,
      heartbeatMs,
      apiKey,
      logger,
    ).finally(() => {
      activeJobs.delete(promise);
    });
    activeJobs.add(promise);
    await promise;
  }
}

void bootstrap();
