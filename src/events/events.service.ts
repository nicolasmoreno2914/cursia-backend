/* ══════════════════════════════════════════════════════════════
   events.service.ts — Registro de eventos de uso
   ══════════════════════════════════════════════════════════════

   Responsabilidades:
   - Guardar el evento en usage_events.
   - Calcular estimated_cost_usd usando CostRatesService.
   - NUNCA lanzar excepción visible al usuario por fallo de BD.
     Si la inserción falla, se loguea y se devuelve ok=false.
   ══════════════════════════════════════════════════════════════ */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsageEvent } from './entities/usage-event.entity';
import { CreateEventDto } from './dto/create-event.dto';
import { CostRatesService } from '../admin/services/cost-rates.service';
import { AuthUser } from '../auth/auth.types';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectRepository(UsageEvent)
    private readonly eventRepo: Repository<UsageEvent>,
    private readonly costRatesService: CostRatesService,
  ) {}

  /**
   * Resuelve el proveedor y servicio correcto para el lookup de cost_rates,
   * independientemente del event_type que llega del frontend.
   *
   * Las tarifas en cost_rates usan service='chat_completion' (IA) o
   * service='video_generation' (video). El event_type no debe usarse
   * directamente como service o nunca habrá match.
   */
  private _resolveCostServiceKey(dto: CreateEventDto): { provider?: string; service?: string } {
    const et = dto.event_type ?? '';

    // IA — cualquier evento ia_* o course_created con tokens
    if (et.startsWith('ia_') || et === 'course_created') {
      return {
        provider: dto.ai_provider || 'anthropic',
        service:  'chat_completion',
      };
    }

    // Video — completados/fallidos/solicitados
    if (et.startsWith('video_') || et === 'youtube_upload_completed' || et === 'youtube_upload_failed') {
      return {
        provider: 'video_engine',
        service:  'video_generation',
      };
    }

    // Audio — ElevenLabs (coste por job si hay tarifa)
    if (et === 'welcome_audio_generated' || et === 'audiobook_generated') {
      return {
        provider: dto.ai_provider || 'elevenlabs',
        service:  'audio_generation',
      };
    }

    // Sin mapeo conocido → sin coste
    return { provider: undefined, service: undefined };
  }

  async create(dto: CreateEventDto, user: AuthUser): Promise<{ ok: boolean; id?: string }> {
    try {
      // ── 1. Calcular coste estimado ───────────────────────────────
      const costKey = this._resolveCostServiceKey(dto);
      const estimatedCostUsd = await this.costRatesService.estimateCostFromEvent({
        provider:    costKey.provider,
        service:     costKey.service,
        model:       dto.ai_model,
        tokensInput:  dto.tokens_input,
        tokensOutput: dto.tokens_output,
        videoCount:   dto.video_count,
      });

      // ── 2. Construir entidad ─────────────────────────────────────
      const event = this.eventRepo.create({
        userId:          user.id,
        userEmail:       user.email || null,
        eventType:       dto.event_type,
        failed:          dto.failed ?? false,
        errorMessage:    dto.error_message  ?? null,
        tokensInput:     dto.tokens_input   ?? null,
        tokensOutput:    dto.tokens_output  ?? null,
        aiModel:         dto.ai_model       ?? null,
        aiProvider:      dto.ai_provider    ?? null,
        estimatedCostUsd: estimatedCostUsd   ?? null,
        videoJobId:      dto.video_job_id   ?? null,
        videoBatchId:    dto.video_batch_id ?? null,
        videoCount:      dto.video_count    ?? null,
        courseId:        dto.course_id      ?? null,
        durationMs:      dto.duration_ms    ?? null,
        metadata:        dto.metadata       ?? null,
      });

      // ── 3. Guardar ───────────────────────────────────────────────
      const saved = await this.eventRepo.save(event);
      return { ok: true, id: saved.id };
    } catch (e) {
      // Fire-and-forget: logueamos pero no rompemos el cliente
      this.logger.error('Error saving usage event', e);
      return { ok: false };
    }
  }
}
