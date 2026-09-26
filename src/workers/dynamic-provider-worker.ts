import 'reflect-metadata';
import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MissingSchemaBackoff, holdIdleIfDynamicDisabled } from './dynamic-worker-gate';
import { ClaimedItem, DEFAULT_LEASE_SECONDS, SchedulerService } from '../modules/dynamic-generation/scheduler.service';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import type { ManifestItemType } from '../modules/generation-manifests/generation-manifest-builder';
import { FinopsLedgerService } from '../modules/finops/finops-ledger.service';
import { FinopsBudgetService } from '../modules/finops/finops-budget.service';
import { WorkerBudget, WorkerLedger, blockWithoutGuard, budgetExceededMessage, recordProviderMock } from './finops-worker-hooks';
import {
  ALLOW_PROVIDER_MOCK_ENV,
  PROVIDER_MODE_UNSET,
  ProviderMode,
  frozenProviderModesOf,
  isProviderMockAllowed,
  providerKindOfItemType,
} from '../modules/dynamic-generation/provider-modes';

// ─────────────────────────────────────────────────────────────────────────────
// Cursia V2.1 — R4: worker de items de PROVEEDOR de rulesVersion 3 que no son
// video: `presentation` (Gamma) y `audio_welcome` / `audiobook_chapter` (TTS).
// Espejo mínimo del camino de claim de dynamic-item-worker (video): claim
// global sin ownerId (worker interno), un artifact por item, completeItem.
//
// ESTADO: stubs. R9 (Gamma) y R10 (TTS) cablean los proveedores reales.
// Fix round 1 (review G2 I1): el modo sale de `input_payload.providerModes`
// ({presentation, audio}, congelado al crear el run; ver provider-modes.ts),
// NUNCA de videoMode:
//  - 'real' (default y único de producción): falla FUERTE con
//    PROVIDER_NOT_WIRED_V21 (item `failed`, no reintentable, dependientes
//    `blocked`) — nunca una salida falsa ni una llamada a un proveedor.
//  - 'mock' (pedido explícito + DYNAMIC_ALLOW_PROVIDER_MOCK=true, que se
//    vuelve a exigir acá): fixture determinística, artifact con
//    `metadata.mock=true` (el empaque real la rechaza:
//    assertNoMockArtifactsForRealPackage).
//  - sin modos congelados (run v3 previo a este fix) → PROVIDER_MODE_UNSET.
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_NOT_WIRED_V21 = 'PROVIDER_NOT_WIRED_V21';

/** Tipos que reclama este worker (nunca el navegador: ver WORKER_ONLY_TYPES del scheduler). */
export const PROVIDER_WORKER_TYPES: readonly ManifestItemType[] = ['presentation', 'audio_welcome', 'audiobook_chapter'];

export type { ProviderMode };

/** Proveedor que produciría el item en modo real (para el mensaje y el costo). */
export function providerOfType(type: string): 'gamma' | 'tts' {
  if (type === 'presentation') return 'gamma';
  if (type === 'audio_welcome' || type === 'audiobook_chapter') return 'tts';
  throw new Error(`dynamic-provider-worker: type no soportado: ${type}`);
}

/**
 * Modo congelado del run para el proveedor de `itemType`. `null` = no hay
 * modos congelados (nunca se asume uno: el item falla con PROVIDER_MODE_UNSET).
 */
export function providerModeOf(inputPayload: any, itemType: string): ProviderMode | null {
  const kind = providerKindOfItemType(itemType);
  const modes = frozenProviderModesOf(inputPayload);
  if (!kind || !modes) return null;
  return modes[kind];
}

export class ProviderNotWiredError extends Error {
  constructor(public readonly itemType: string, public readonly itemKey: string) {
    super(
      `${PROVIDER_NOT_WIRED_V21}: el item ${itemKey} (${itemType}) necesita el proveedor real ` +
        `${providerOfType(itemType) === 'gamma' ? 'Gamma' : 'TTS'}, que todavía no está cableado en V2.1 ` +
        '(bloques R9/R10). No se generó nada ni hubo gasto. Usá un run mock o esperá ese bloque.',
    );
    this.name = 'ProviderNotWiredError';
  }
}

export interface ProviderFixtureOutput {
  artifactType: 'dynamic_presentation' | 'dynamic_audio_mp3';
  filename: string;
  payload: Record<string, unknown>;
  summary: Record<string, unknown>;
}

/**
 * Fixture determinística de un item de proveedor en modo mock. Pura: solo lee
 * type/itemKey/idempotencyKey/chapterId/chapterNumber del item (sin clock,
 * sin random). El payload declara `fixture: true` para que nadie lo confunda
 * con una salida real.
 */
export function mockProviderOutput(item: Pick<ClaimedItem, 'type' | 'itemKey' | 'idempotencyKey' | 'chapterId' | 'chapterNumber'>): ProviderFixtureOutput {
  const provider = providerOfType(item.type);
  const digest = createHash('sha256').update(`${item.type}|${item.itemKey}|${item.idempotencyKey}`, 'utf8').digest('hex');
  const entity = item.chapterId ?? 'course';
  if (item.type === 'presentation') {
    const slideCount = 6 + (parseInt(digest.slice(0, 2), 16) % 5);
    return {
      artifactType: 'dynamic_presentation',
      filename: `${entity}.presentation.json`,
      payload: {
        fixture: true,
        provider,
        mode: 'mock',
        itemKey: item.itemKey,
        chapterId: item.chapterId,
        chapterNumber: item.chapterNumber,
        gammaId: `mock_gamma_${digest.slice(0, 16)}`,
        slideCount,
        pdfUrl: null,
        coverPngUrl: null,
      },
      summary: { mode: 'mock', fixture: true, mock: true, provider, slideCount },
    };
  }
  const durationSeconds = item.type === 'audio_welcome' ? 45 : 150 + (parseInt(digest.slice(0, 2), 16) % 60);
  return {
    artifactType: 'dynamic_audio_mp3',
    filename: `${entity}.${item.type}.json`,
    payload: {
      fixture: true,
      provider,
      mode: 'mock',
      itemKey: item.itemKey,
      chapterId: item.chapterId,
      chapterNumber: item.chapterNumber,
      audioId: `mock_tts_${digest.slice(0, 16)}`,
      durationSeconds,
      mp3Url: null,
      script: item.type === 'audiobook_chapter' ? `[fixture] guion del capítulo ${item.chapterNumber}` : '[fixture] bienvenida',
    },
    summary: { mode: 'mock', fixture: true, mock: true, provider, durationSeconds },
  };
}

export interface ProviderWorkerDeps {
  scheduler: Pick<SchedulerService, 'claimNextItem' | 'completeItem' | 'failItem'> & Partial<Pick<SchedulerService, 'blockItemForBudget'>>;
  dataSource: Pick<DataSource, 'query'>;
  artifacts: Pick<ArtifactsService, 'uploadJsonArtifact'>;
  logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  executorId: string;
  leaseSeconds: number;
  /** V2.1 RF-b: ledger (mock → evento MOCK a 0). El bootstrap SIEMPRE lo cablea. */
  finops?: WorkerLedger | null;
  /** V2.1 RF-b: runtime guard ANTES de donde iría la llamada real. El bootstrap SIEMPRE lo cablea. */
  budget?: WorkerBudget | null;
}

async function loadRunHead(
  dataSource: Pick<DataSource, 'query'>,
  runId: string,
  itemType: string,
): Promise<{ ownerId: string; mode: ProviderMode | null }> {
  const [row] = await dataSource.query(`select owner_id, input_payload from public.production_jobs where id = $1`, [runId]);
  if (!row) throw new Error(`run ${runId} no encontrado (integridad rota)`);
  return { ownerId: row.owner_id, mode: providerModeOf(row.input_payload, itemType) };
}

/**
 * Procesa UN item reclamado. Modo real → failItem(PROVIDER_NOT_WIRED_V21, no
 * reintentable) y relanza el error (fail loud). Modo mock → fixture +
 * artifact + completeItem.
 */
export async function processProviderItem(deps: ProviderWorkerDeps, item: ClaimedItem): Promise<void> {
  if (!PROVIDER_WORKER_TYPES.includes(item.type)) {
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, `provider_worker_wrong_type: ${item.type}`, false);
    throw new Error(`dynamic-provider-worker: reclamó un item de tipo ${item.type} (${item.itemKey}) que no le corresponde`);
  }
  const head = await loadRunHead(deps.dataSource, item.runId, item.type);
  if (head.mode === null) {
    const msg =
      `${PROVIDER_MODE_UNSET}: el run ${item.runId} no tiene providerModes congelados; el item ${item.itemKey} ` +
      '(Gamma/TTS) no se ejecuta con un modo supuesto. Iniciá un run nuevo.';
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, msg, false);
    throw new Error(msg);
  }
  if (head.mode === 'mock' && !isProviderMockAllowed()) {
    const msg =
      `provider_mock_not_allowed: el run ${item.runId} está congelado en mock para ${item.type} pero ` +
      `${ALLOW_PROVIDER_MOCK_ENV}≠true en este entorno; no se produce una fixture.`;
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, msg, false);
    throw new Error(msg);
  }
  if (head.mode === 'real') {
    // V2.1 RF-b: runtime guard de presupuesto ANTES de la llamada pagada (que
    // R9/R10 cablean acá). Excedido → item `blocked` budget_exceeded, sin gasto.
    // RF-b fix round 2 (M3): sin guard → fail CLOSED (item bloqueado, nunca una llamada pagada).
    if (!deps.budget) {
      deps.logger.error(`Item ${item.itemKey}: runtime guard de presupuesto no configurado — no se llama al proveedor (fail closed)`);
      await blockWithoutGuard(deps.scheduler, item.itemRunId, deps.executorId, providerOfType(item.type) === 'gamma' ? 'Gamma' : 'TTS');
      return;
    }
    {
      const g = await deps.budget.guardPaidSubmission({ runId: item.runId, itemRunId: item.itemRunId, itemType: item.type });
      if (!g.allow) {
        if (!deps.scheduler.blockItemForBudget) throw new Error('dynamic-provider-worker: scheduler sin blockItemForBudget');
        deps.logger.warn(`Item ${item.itemKey}: presupuesto excedido (${g.reason}) — no se llama al proveedor`);
        await deps.scheduler.blockItemForBudget(item.itemRunId, deps.executorId, budgetExceededMessage(g));
        return;
      }
    }
    const err = new ProviderNotWiredError(item.type, item.itemKey);
    await deps.scheduler.failItem(item.itemRunId, deps.executorId, err.message, false);
    throw err;
  }

  const out = mockProviderOutput(item);
  const storagePath =
    `${head.ownerId}/dynamic/${item.artifactCourseId}/${item.manifestId}/${out.artifactType}/` +
    `${item.idempotencyKey}/a${item.attempt}.json`;
  const artifact = await deps.artifacts.uploadJsonArtifact({
    ownerId: head.ownerId,
    courseId: item.artifactCourseId,
    jobId: item.runId,
    type: out.artifactType,
    filename: out.filename,
    storagePath,
    payload: out.payload,
    mimeType: 'application/json',
    metadata: { manifestId: item.manifestId, itemKey: item.itemKey, chapterId: item.chapterId, fixture: true, mock: true },
    upsert: false,
  });
  // V2.1 RF-b: evento MOCK (monto 0), idempotente por el id de la fixture.
  if (deps.finops) {
    const externalId = String((out.payload as any).gammaId ?? (out.payload as any).audioId);
    try {
      await recordProviderMock(deps.finops, { ownerId: head.ownerId, itemRunId: item.itemRunId, itemType: item.type, externalId });
    } catch (err) {
      deps.logger.error(`finops: no se pudo registrar el evento mock de ${item.itemKey} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const ok = await deps.scheduler.completeItem(item.itemRunId, deps.executorId, {
    artifactIds: [artifact.id],
    summary: out.summary,
  });
  if (!ok) {
    deps.logger.warn(
      `Item ${item.itemKey}: fixture subida (artifact ${artifact.id}) pero completeItem devolvió false (lease perdida)`,
    );
  }
}

export async function runProviderOnce(deps: ProviderWorkerDeps): Promise<'claimed' | 'idle'> {
  const item = await deps.scheduler.claimNextItem({
    executorId: deps.executorId,
    types: [...PROVIDER_WORKER_TYPES],
    leaseSeconds: deps.leaseSeconds,
  });
  if (!item) return 'idle';
  try {
    await processProviderItem(deps, item);
  } catch (err) {
    deps.logger.error(`Item ${item.itemKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return 'claimed';
}

function readPositiveInt(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * Proceso standalone. V2.1 RF-b: cableado en PM2 (deploy.yml /
 * deploy-staging.yml, `start:dynamic-provider-worker`) igual que
 * dynamic-item-worker. Mismo gate (flag + esquema ausente).
 */
async function bootstrap() {
  const logger = new Logger('DynamicProviderWorker');
  if (holdIdleIfDynamicDisabled(logger, 'dynamic-provider-worker')) return;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  const deps: ProviderWorkerDeps = {
    scheduler: app.get(SchedulerService),
    dataSource: app.get(DataSource),
    artifacts: app.get(ArtifactsService),
    logger,
    executorId: process.env.DYNAMIC_PROVIDER_WORKER_ID || `dynamic-provider-worker-${process.pid}`,
    leaseSeconds: readPositiveInt('DYNAMIC_PROVIDER_WORKER_LEASE_SECONDS', DEFAULT_LEASE_SECONDS),
    finops: app.get(FinopsLedgerService),
    budget: app.get(FinopsBudgetService),
  };
  const pollMs = readPositiveInt('DYNAMIC_PROVIDER_WORKER_POLL_MS', 5000);
  let shuttingDown = false;
  const stop = async () => {
    shuttingDown = true;
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  logger.log(`dynamic-provider-worker iniciado (executorId=${deps.executorId}, pollMs=${pollMs}, tipos=${PROVIDER_WORKER_TYPES.join(',')})`);
  const schema = new MissingSchemaBackoff(logger, 'dynamic-provider-worker');
  while (!shuttingDown) {
    let wait = pollMs;
    try {
      const r = await runProviderOnce(deps);
      schema.onClaimOk();
      if (r === 'claimed') wait = 0;
    } catch (err) {
      const w = schema.onClaimError(err);
      if (w === null) throw err;
      wait = w;
    }
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  await app.close();
  process.exit(0);
}

if (require.main === module) {
  bootstrap().catch((err) => {
    new Logger('DynamicProviderWorker').error(`Fatal bootstrap error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}
