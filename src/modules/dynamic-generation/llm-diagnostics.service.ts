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
/** Review I2: tope de bytes del texto devuelto (la respuesta JSON no crece sin límite) y descargas en paralelo acotadas. */
export const LLM_DIAGNOSTICS_MAX_BYTES = 8 * 1024 * 1024;
const LLM_DIAGNOSTICS_CONCURRENCY = 4;

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

  /**
   * `opts.hash`: solo ese checkpoint; `opts.limit`: primeros N (por `at`, desempate por hash). Con más checkpoints que
   * el tope, o más bytes que LLM_DIAGNOSTICS_MAX_BYTES, `truncated: true` (los restantes se piden con `hash`/`limit`).
   */
  async forItem(runId: string, itemKey: string, opts: { hash?: string | null; limit?: number | null; maxBytes?: number } = {}): Promise<LlmItemDiagnostics> {
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
    let entries = Object.entries(cps as Record<string, { path?: unknown; at?: unknown }>)
      .sort((a, b) => String(a[1]?.at ?? '').localeCompare(String(b[1]?.at ?? '')) || a[0].localeCompare(b[0]));
    if (opts.hash) entries = entries.filter(([h]) => h === opts.hash);
    const cap = Math.max(1, Math.min(LLM_DIAGNOSTICS_MAX_CHECKPOINTS, Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? (opts.limit as number) : LLM_DIAGNOSTICS_MAX_CHECKPOINTS));
    let truncated = entries.length > cap;
    entries = entries.slice(0, cap);
    // Review M3: SOLO la forma exacta que escribe server-llm.ts — <dueño>/dynamic/<curso>/<manifest>/llm-checkpoints/<itemRunId>/<hash>.json.
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const shape = new RegExp(`^${esc(String(row.owner_id))}/dynamic/[A-Za-z0-9_-]+/[0-9]+/llm-checkpoints/${esc(String(row.id))}/([0-9a-f]{40,64})\\.json$`);
    const out: LlmCheckpointDump[] = new Array(entries.length);
    let bytes = 0;
    const budget = opts.maxBytes ?? LLM_DIAGNOSTICS_MAX_BYTES;
    let next = 0;
    const work = async () => {
      for (;;) {
        const i = next++;
        if (i >= entries.length) return;
        const [hash, cp] = entries[i];
        const path = typeof cp?.path === 'string' ? cp.path : '';
        const at = typeof cp?.at === 'string' ? cp.at : null;
        const m = shape.exec(path);
        if (!/^[0-9a-f]{40,64}$/.test(hash) || !m || m[1] !== hash) {
          out[i] = { hash, at, text: null, usage: null, stopReason: null, error: 'ruta de checkpoint fuera de la parte' };
          continue;
        }
        if (bytes >= budget) {
          truncated = true;
          out[i] = { hash, at, text: null, usage: null, stopReason: null, error: 'omitido: tope de bytes de la respuesta (pedirlo con ?hash=)' };
          continue;
        }
        try {
          const buf = await this.artifacts.downloadStorageObject('cursia-artifacts', path);
          // Descargas en paralelo: el tope se aplica al SUMAR (nunca se devuelve más que el tope).
          if (bytes + buf.length > budget) {
            truncated = true;
            out[i] = { hash, at, text: null, usage: null, stopReason: null, error: 'omitido: tope de bytes de la respuesta (pedirlo con ?hash=)' };
            continue;
          }
          bytes += buf.length;
          const saved = JSON.parse(buf.toString('utf8'));
          out[i] = {
            hash, at,
            text: typeof saved?.text === 'string' ? saved.text : null,
            usage: saved?.usage && typeof saved.usage === 'object' ? saved.usage : null,
            stopReason: typeof saved?.stopReason === 'string' ? saved.stopReason : null,
          };
        } catch (err) {
          out[i] = { hash, at, text: null, usage: null, stopReason: null, error: `ilegible: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LLM_DIAGNOSTICS_CONCURRENCY, entries.length) }, work));
    return {
      runId, itemKey, itemRunId: String(row.id), status: String(row.status),
      attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts),
      claim, checkpoints: out, truncated,
    };
  }
}
