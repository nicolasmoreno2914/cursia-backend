import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CoherenceService } from '../coherence/coherence.service';
import { computePilotMetrics, PilotMetricsNotFound } from './pilot-metrics';

/**
 * Loop 10 C2 — métricas del piloto de un run (SuperAdmin, SOLO LECTURA). Las consultas corren en una transacción
 * READ ONLY (Postgres rechaza cualquier escritura) y siempre terminan en ROLLBACK. La batería de calidad la arma
 * CoherenceService.qualityReport (solo lectura; lee los artifacts del storage); si no se puede (run en curso, owner
 * fuera de la allowlist, storage), la sección dice por qué. Sin llamadas a proveedores.
 */
@Injectable()
export class PilotMetricsService {
  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly coherence?: CoherenceService,
  ) {}

  async forRun(runId: string): Promise<Record<string, unknown>> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query('start transaction read only');
      return await computePilotMetrics(qr, runId, {
        quality: this.coherence
          ? async (r) => {
            if (r.blueprintNumber == null) throw new Error('el run no tiene blueprintNumber en input_payload');
            return this.coherence!.qualityReport(r.courseId, r.ownerId, r.blueprintNumber, r.runId);
          }
          : null,
        qualityUnavailableReason: 'CoherenceService no disponible',
      });
    } catch (err) {
      if (err instanceof PilotMetricsNotFound) throw new NotFoundException({ code: 'run_not_found', message: `No existe la ejecución dinámica ${runId}` });
      throw err;
    } finally {
      try { await qr.query('rollback'); } catch { /* sin transacción abierta */ }
      await qr.release();
    }
  }
}
