/* ══════════════════════════════════════════════════════════════
   events.service.ts — Registro de eventos de uso
   ══════════════════════════════════════════════════════════════

   Responsabilidades:
   - Guardar el evento en usage_events.
   - Calcular estimated_cost_usd usando CostRatesService.
   - NUNCA lanzar excepción visible al usuario por fallo de BD.
     Si la inserción falla, se loguea y se devuelve ok=false.
   ══════════════════════════════════════════════════════════════ */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsageEvent } from './entities/usage-event.entity';
import { CreateEventDto } from './dto/create-event.dto';
import { CostRatesService } from '../admin/services/cost-rates.service';
import { AuthUser } from '../auth/auth.types';
import { resolveCourseRef } from '../modules/authz/resource-resolver';

/** r75 B1 (H8c): tipos de evento que solo escribe el servidor (p. ej. el registro de renders del Video Engine, H3). */
export const SERVER_ONLY_EVENT_PREFIX = 'server.';
export function isServerOnlyEventType(t: unknown): boolean {
  return typeof t === 'string' && t.trim().toLowerCase().startsWith(SERVER_ONLY_EVENT_PREFIX);
}
import {
  UsageEventComponent,
  UsageEventCostSource,
  UsageEventCostType,
  UsageEventMode,
} from './entities/usage-event.entity';

export interface BackendUsageEventInput {
  userId: string;
  userEmail?: string | null;
  organizationId?: string | null;
  eventType: string;
  failed?: boolean;
  errorMessage?: string | null;
  courseId?: string | null;
  jobId?: string | null;
  parentJobId?: string | null;
  component?: UsageEventComponent | null;
  provider?: string | null;
  model?: string | null;
  service?: string | null;
  mode?: UsageEventMode | null;
  costType?: UsageEventCostType | null;
  estimatedCostUsd?: number | null;
  realCostUsd?: number | null;
  costSource?: UsageEventCostSource | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  units?: number | null;
  unitType?: string | null;
  unitPriceUsd?: number | null;
  durationMs?: number | null;
  metadata?: Record<string, any> | null;
}

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

  private _inferLegacyComponent(eventType: string): UsageEventComponent | null {
    const et = String(eventType || '');
    if (et.startsWith('ia_')) return 'content';
    if (et.startsWith('video_')) return 'video';
    if (et.startsWith('youtube_')) return 'youtube';
    if (et.includes('audio') || et.includes('audiobook')) return 'audio';
    if (et.includes('mbz') || et.includes('export')) return 'package';
    if (et.includes('cloud')) return 'storage';
    return 'orchestration';
  }

  private async _persistEvent(input: BackendUsageEventInput): Promise<{ ok: boolean; id?: string }> {
    try {
      const normalizedMode: UsageEventMode = input.mode ?? 'unknown';
      let normalizedCostType: UsageEventCostType = input.costType ?? 'unknown';
      let estimatedCostUsd = input.estimatedCostUsd ?? null;
      const realCostUsd = input.realCostUsd ?? null;
      let costSource: UsageEventCostSource | null = input.costSource ?? null;
      let unitPriceUsd = input.unitPriceUsd ?? null;
      let unitType = input.unitType ?? null;

      if (normalizedCostType === 'mock_zero') {
        estimatedCostUsd = 0;
        costSource = 'mock_zero';
      } else if (normalizedCostType === 'estimated' && estimatedCostUsd == null) {
        const resolved = await this.costRatesService.resolveCostEstimate({
          provider: input.provider ?? undefined,
          service: input.service ?? undefined,
          model: input.model ?? undefined,
          tokensInput: input.tokensInput ?? undefined,
          tokensOutput: input.tokensOutput ?? undefined,
          units: input.units ?? undefined,
          unitType: input.unitType ?? undefined,
        });
        estimatedCostUsd = resolved.costUsd;
        unitPriceUsd = unitPriceUsd ?? resolved.unitPriceUsd;
        unitType = unitType ?? resolved.unitType;
        costSource = (resolved.source as UsageEventCostSource | null) ?? costSource ?? 'configured_rate';
        if (estimatedCostUsd == null) {
          normalizedCostType = 'unknown';
          costSource = 'not_tracked';
        }
      } else if (normalizedCostType === 'unknown') {
        costSource = costSource ?? 'not_tracked';
      } else if (normalizedCostType === 'real') {
        costSource = costSource ?? 'provider_reported';
      }

      const provider = input.provider ?? null;
      const model = input.model ?? null;
      const event = this.eventRepo.create({
        userId: input.userId,
        userEmail: input.userEmail ?? null,
        organizationId: input.organizationId ?? null,
        eventType: input.eventType,
        failed: input.failed ?? false,
        errorMessage: input.errorMessage ?? null,
        component: input.component ?? this._inferLegacyComponent(input.eventType),
        tokensInput: input.tokensInput ?? null,
        tokensOutput: input.tokensOutput ?? null,
        aiModel: model,
        aiProvider: provider,
        provider,
        model,
        mode: normalizedMode,
        estimatedCostUsd,
        realCostUsd,
        costType: normalizedCostType,
        costSource,
        units: input.units ?? null,
        unitType,
        unitPriceUsd,
        videoJobId: input.metadata?.videoJobId ?? null,
        videoBatchId: input.metadata?.videoBatchId ?? null,
        videoCount: input.metadata?.videoCount ?? null,
        courseId: input.courseId ?? null,
        jobId: input.jobId ?? null,
        parentJobId: input.parentJobId ?? null,
        durationMs: input.durationMs ?? null,
        metadata: input.metadata ?? null,
      });

      const saved = await this.eventRepo.save(event);
      return { ok: true, id: saved.id };
    } catch (e) {
      this.logger.error('Error saving usage event', e);
      return { ok: false };
    }
  }

  /**
   * POST /events (navegador). FinOps P0: es solo telemetría de actividad. Los campos de dinero que manda el cliente
   * (`real_cost_usd`, `cost_type`='real', `cost_source`) NO son de confianza (cualquier sesión puede forjarlos): no
   * se guardan como costo (real_cost_usd = null, cost_type nunca 'real') y quedan solo como dato declarado en
   * metadata.clientDeclaredCost con costUntrusted=true. Ningún lector de dinero lee usage_events (ver CostReadService).
   */
  /**
   * r75 B1 (H8c): `course_id` del body era libre. Si apunta a un curso (id numérico o UUID del frontend) que existe y
   * NO es del usuario (y él no tiene ninguno con esa referencia), no se guarda: queda null y la referencia declarada en
   * `metadata.courseIdRejected` (fire-and-forget: nunca falla el request). Un id que no existe se guarda como hoy (V1
   * usa ids locales del navegador).
   */
  private async scopedCourseId(raw: string | null | undefined, userId: string): Promise<{ courseId: string | null; rejected: string | null }> {
    if (raw === null || raw === undefined || String(raw).trim() === '') return { courseId: null, rejected: null };
    try {
      const matches = await resolveCourseRef((sql, params) => this.eventRepo.query(sql, params as any[]), raw, userId);
      if (!matches.length || matches.some((c) => c.ownerId === userId)) return { courseId: String(raw), rejected: null };
      return { courseId: null, rejected: String(raw).slice(0, 120) };
    } catch {
      return { courseId: String(raw), rejected: null }; // la base de eventos nunca corta el request (igual que antes)
    }
  }

  async create(dto: CreateEventDto, user: AuthUser): Promise<{ ok: boolean; id?: string }> {
    if (isServerOnlyEventType(dto.event_type)) {
      throw new BadRequestException({ code: 'event_type_reserved', message: 'event_type_reserved: los eventos server.* los registra solo el servidor.' });
    }
    const scoped = await this.scopedCourseId(dto.course_id, user.id);
    const costKey = this._resolveCostServiceKey(dto);
    const declaredType = dto.cost_type as UsageEventCostType | undefined;
    const costType: UsageEventCostType = (declaredType && declaredType !== 'real' ? declaredType : undefined)
      ?? ((dto.tokens_input || dto.tokens_output || dto.video_count) ? 'estimated' : 'unknown');
    const clientDeclaredCost = (dto.real_cost_usd !== undefined && dto.real_cost_usd !== null) || dto.cost_type !== undefined || dto.cost_source !== undefined
      ? { cost_type: dto.cost_type ?? null, real_cost_usd: dto.real_cost_usd ?? null, cost_source: dto.cost_source ?? null }
      : null;
    const mode: UsageEventMode = dto.mode as UsageEventMode ?? 'unknown';
    return this._persistEvent({
      userId: user.id,
      userEmail: user.email || null,
      organizationId: dto.organization_id ?? null,
      eventType: dto.event_type,
      failed: dto.failed ?? false,
      errorMessage: dto.error_message ?? null,
      courseId: scoped.courseId,
      jobId: dto.job_id ?? null,
      parentJobId: dto.parent_job_id ?? null,
      component: (dto.component as UsageEventComponent) ?? this._inferLegacyComponent(dto.event_type),
      provider: dto.provider ?? dto.ai_provider ?? costKey.provider ?? null,
      model: dto.model ?? dto.ai_model ?? null,
      service: costKey.service ?? null,
      mode,
      costType,
      estimatedCostUsd: undefined,
      realCostUsd: null,
      costSource: null,
      tokensInput: dto.tokens_input ?? null,
      tokensOutput: dto.tokens_output ?? null,
      units: dto.units ?? dto.video_count ?? null,
      unitType: dto.unit_type ?? null,
      unitPriceUsd: dto.unit_price_usd ?? null,
      durationMs: dto.duration_ms ?? null,
      metadata: {
        ...(dto.metadata ?? {}),
        ...(clientDeclaredCost ? { clientDeclaredCost, costUntrusted: true } : {}),
        ...(scoped.rejected ? { courseIdRejected: scoped.rejected } : {}),
        videoJobId: dto.video_job_id ?? dto.metadata?.videoJobId ?? null,
        videoBatchId: dto.video_batch_id ?? dto.metadata?.videoBatchId ?? null,
        videoCount: dto.video_count ?? dto.metadata?.videoCount ?? null,
      },
    });
  }

  async trackBackendEvent(input: BackendUsageEventInput): Promise<{ ok: boolean; id?: string }> {
    return this._persistEvent(input);
  }
}
