import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { ClaimedItem, SchedulerService } from './scheduler.service';

/**
 * Diagnóstico de una parte generada por el worker de IA (SUPER_ADMIN, SOLO LECTURA; 2026-10-14, examen final de
 * #1353): el payload exacto del claim (SchedulerService.claimPreview, transacción READ ONLY) y las respuestas PAGADAS
 * guardadas en sus puntos de guardado (`output_summary.llmCheckpoints` → Storage). Con ambos, la parte se reproduce
 * localmente con el ejecutor y los validadores reales a USD 0: los prompts coinciden byte a byte (hash del body).
 * Nunca escribe, nunca llama a un proveedor; solo lee rutas de checkpoint de ESA parte (prefijo verificado).
 */
export const LLM_DIAGNOSTICS_MAX_CHECKPOINTS = 300;

export interface LlmCheckpointDump {
  hash: string;
  at: string | null;
  text: string | null;
  usage: Record<string, number> | null;
  stopReason: string | null;
  error?: string;
}

export interface LlmItemDiagnostics {
  runId: string;
  itemKey: string;
  itemRunId: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  claim: ClaimedItem;
  checkpoints: LlmCheckpointDump[];
  truncated: boolean;
}

@Injectable()
export class LlmDiagnosticsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly scheduler: SchedulerService,
    private readonly artifacts: ArtifactsService,
  ) {}

  async forItem(runId: string, itemKey: string): Promise<LlmItemDiagnostics> {
    const [row] = await this.dataSource.query(
      `select g.id, g.status, g.attempt_count, g.max_attempts, g.output_summary, r.owner_id
         from public.generation_item_runs g join public.production_jobs r on r.id = g.job_id
        where g.job_id = $1 and g.item_key = $2 order by g.generation desc limit 1`,
      [runId, itemKey],
    );
    if (!row) throw new NotFoundException(`Parte ${itemKey} no encontrada en el run ${runId}`);
    const claim = await this.scheduler.claimPreview(runId, itemKey);
    const os = row.output_summary && typeof row.output_summary === 'object' ? row.output_summary : {};
    const cps = os.llmCheckpoints && typeof os.llmCheckpoints === 'object' ? os.llmCheckpoints : {};
    const entries = Object.entries(cps as Record<string, { path?: unknown; at?: unknown }>)
      .sort((a, b) => String(a[1]?.at ?? '').localeCompare(String(b[1]?.at ?? '')));
    // Solo rutas de checkpoint de ESTA parte y de su dueño (mismo formato que server-llm.ts).
    const prefix = `${row.owner_id}/dynamic/`;
    const marker = `/llm-checkpoints/${row.id}/`;
    const out: LlmCheckpointDump[] = [];
    for (const [hash, cp] of entries.slice(0, LLM_DIAGNOSTICS_MAX_CHECKPOINTS)) {
      const path = typeof cp?.path === 'string' ? cp.path : '';
      const at = typeof cp?.at === 'string' ? cp.at : null;
      if (!/^[0-9a-f]{40,64}$/.test(hash) || !path.startsWith(prefix) || !path.includes(marker) || path.includes('..')) {
        out.push({ hash, at, text: null, usage: null, stopReason: null, error: 'ruta de checkpoint fuera de la parte' });
        continue;
      }
      try {
        const saved = JSON.parse((await this.artifacts.downloadStorageObject('cursia-artifacts', path)).toString('utf8'));
        out.push({
          hash, at,
          text: typeof saved?.text === 'string' ? saved.text : null,
          usage: saved?.usage && typeof saved.usage === 'object' ? saved.usage : null,
          stopReason: typeof saved?.stopReason === 'string' ? saved.stopReason : null,
        });
      } catch (err) {
        out.push({ hash, at, text: null, usage: null, stopReason: null, error: `ilegible: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` });
      }
    }
    return {
      runId, itemKey, itemRunId: String(row.id), status: String(row.status),
      attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts),
      claim, checkpoints: out, truncated: entries.length > LLM_DIAGNOSTICS_MAX_CHECKPOINTS,
    };
  }
}
