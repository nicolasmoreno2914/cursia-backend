/* ══════════════════════════════════════════════════════════════
   admin-dashboard.service.ts — Métricas agregadas del dashboard
   ══════════════════════════════════════════════════════════════

   Todas las queries son READ-ONLY sobre usage_events.
   Devuelve ceros seguros cuando no hay datos (nunca null-bomb).
   ══════════════════════════════════════════════════════════════ */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsageEvent } from '../../events/entities/usage-event.entity';
import { TraditionalCostBenchmark } from '../entities/traditional-cost-benchmark.entity';

export interface DashboardSummary {
  period: { from: string; to: string };
  events: { total: number; failed: number };
  courses: { created: number };
  tokens: {
    input_total: number;
    output_total: number;
    estimated_cost_usd: number;
  };
  videos: {
    requested: number;
    generated: number;
    uploaded_youtube: number;
    failed: number;
    estimated_cost_usd: number;
  };
  audio: {
    welcome_generated: number;
    audiobooks_generated: number;
    estimated_cost_usd: number;
  };
  production: {
    completed: number;
  };
  exports: { mbz_total: number };
  total_estimated_cost_usd: number;
  traditional_equivalent_usd: number;
  savings_usd: number;
  failures: { total: number };
}

@Injectable()
export class AdminDashboardService {
  constructor(
    @InjectRepository(UsageEvent)
    private readonly eventRepo: Repository<UsageEvent>,
    @InjectRepository(TraditionalCostBenchmark)
    private readonly benchmarkRepo: Repository<TraditionalCostBenchmark>,
  ) {}

  async getSummary(from: Date, to: Date): Promise<DashboardSummary> {
    // ── 1. Eventos totales y fallidos ──────────────────────────────────────────
    const totalEvents = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .getCount();

    const failedEvents = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere('e.failed = true')
      .getCount();

    // ── 2. Cursos creados ─────────────────────────────────────────────────────
    const coursesCreated = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type = 'course_created'")
      .getCount();

    // ── 3. Tokens IA + coste ──────────────────────────────────────────────────
    const tokenStats = await this.eventRepo
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.tokens_input), 0)',    'inputTotal')
      .addSelect('COALESCE(SUM(e.tokens_output), 0)', 'outputTotal')
      .addSelect('COALESCE(SUM(e.estimated_cost_usd), 0)', 'tokensCost')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type LIKE 'ia_%'")
      .getRawOne<{ inputTotal: string; outputTotal: string; tokensCost: string }>();

    const inputTotal   = parseFloat(tokenStats?.inputTotal   ?? '0');
    const outputTotal  = parseFloat(tokenStats?.outputTotal  ?? '0');
    const tokensCostUsd = parseFloat(tokenStats?.tokensCost  ?? '0');

    // ── 4. Videos ─────────────────────────────────────────────────────────────
    const videosRequested = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type IN ('video_job_requested', 'video_batch_requested')")
      .getCount();

    const videosGenerated = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type = 'video_job_completed'")
      .getCount();

    const videosYouTube = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type = 'youtube_upload_completed'")
      .getCount();

    const videosFailed = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type IN ('video_job_failed', 'youtube_upload_failed')")
      .getCount();

    const videoCostStats = await this.eventRepo
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.estimated_cost_usd), 0)', 'videosCost')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type LIKE 'video_%'")
      .getRawOne<{ videosCost: string }>();

    const videosCostUsd = parseFloat(videoCostStats?.videosCost ?? '0');

    // ── 5. Audio ──────────────────────────────────────────────────────────────
    const welcomeAudioCount = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type = 'welcome_audio_generated'")
      .getCount();

    const audiobookCount = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type = 'audiobook_generated'")
      .getCount();

    const audioCostStats = await this.eventRepo
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.estimated_cost_usd), 0)', 'audioCost')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type IN ('welcome_audio_generated', 'audiobook_generated')")
      .getRawOne<{ audioCost: string }>();

    const audioCostUsd = parseFloat(audioCostStats?.audioCost ?? '0');

    // ── 6. Producción completa ────────────────────────────────────────────────
    const productionCompleted = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type = 'course_production_completed'")
      .getCount();

    // ── 7. Exports MBZ ────────────────────────────────────────────────────────
    const mbzTotal = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type IN ('export_mbz', 'mbz_exported')")
      .getCount();

    // ── 8. Coste total ────────────────────────────────────────────────────────
    const totalCostStats = await this.eventRepo
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.estimated_cost_usd), 0)', 'totalCost')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .getRawOne<{ totalCost: string }>();

    const totalCostUsd = parseFloat(totalCostStats?.totalCost ?? '0');

    // ── 9. Ahorro vs. método tradicional ──────────────────────────────────────
    let traditionalEquivalentUsd = 0;

    const benchmarks = await this.benchmarkRepo.find({ where: { isActive: true } });

    // Mapeo simple: course_creation ↔ course_created, video_production ↔ video_job_completed
    const quantityMap: Record<string, number> = {
      course_creation:   coursesCreated,
      video_production:  videosGenerated,
      export_mbz:        mbzTotal,
    };

    for (const b of benchmarks) {
      const qty = quantityMap[b.benchmarkKey] ?? 0;
      traditionalEquivalentUsd += qty * Number(b.typicalCostUsd);
    }

    const savingsUsd = Math.max(0, traditionalEquivalentUsd - totalCostUsd);

    // ── 10. Respuesta ─────────────────────────────────────────────────────────
    return {
      period: {
        from: from.toISOString(),
        to:   to.toISOString(),
      },
      events: {
        total:  totalEvents,
        failed: failedEvents,
      },
      courses: {
        created: coursesCreated,
      },
      tokens: {
        input_total:        Math.round(inputTotal),
        output_total:       Math.round(outputTotal),
        estimated_cost_usd: Number(tokensCostUsd.toFixed(6)),
      },
      videos: {
        requested:          videosRequested,
        generated:          videosGenerated,
        uploaded_youtube:   videosYouTube,
        failed:             videosFailed,
        estimated_cost_usd: Number(videosCostUsd.toFixed(6)),
      },
      audio: {
        welcome_generated:    welcomeAudioCount,
        audiobooks_generated: audiobookCount,
        estimated_cost_usd:   Number(audioCostUsd.toFixed(6)),
      },
      production: {
        completed: productionCompleted,
      },
      exports: {
        mbz_total: mbzTotal,
      },
      total_estimated_cost_usd:   Number(totalCostUsd.toFixed(6)),
      traditional_equivalent_usd: Number(traditionalEquivalentUsd.toFixed(2)),
      savings_usd:                Number(savingsUsd.toFixed(2)),
      failures: {
        total: failedEvents,
      },
    };
  }
}
