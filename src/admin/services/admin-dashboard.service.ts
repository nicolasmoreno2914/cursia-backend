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
  costs: {
    estimated_total_usd: number;
    real_total_usd: number;
    mock_total_usd: number;
    unknown_events: number;
  };
  traditional_equivalent_usd: number;
  savings_usd: number;
  failures: { total: number };
  /** Desglose de costo estimado por proveedor de IA/servicio */
  costByProvider: Array<{ provider: string; cost_usd: number }>;
  /** Cursos completados por dia en el periodo */
  productionTrend: Array<{ date: string; count: number }>;
  courseCostSummary: {
    totalEstimatedCostUsd: number;
    totalRealCostUsd: number;
    totalMockCostUsd: number;
    averageEstimatedCostUsd: number;
    coursesWithCostCount: number;
    coursesWithoutCostCount: number;
    coursesWithUnknownCostCount: number;
  };
  courseCosts: Array<{
    courseId: string;
    courseName: string;
    status: string;
    totalCostUsd: number | null;
    estimatedCostUsd: number;
    realCostUsd: number | null;
    mockCostUsd: number;
    unknownCostUsd: number | null;
    costStatus: 'real' | 'estimated' | 'mock' | 'mixed' | 'unknown';
    costSource: 'estimated' | 'real' | 'mixed' | 'mock' | null;
    contentCostUsd: number;
    audioCostUsd: number;
    videoCostUsd: number;
    packageCostUsd: number;
    h5pCostUsd: number;
    youtubeCostUsd: number;
    storageCostUsd: number;
    hasMissingCostEvents: boolean;
    mode: 'real' | 'mock' | 'dry_run' | 'mixed' | 'unknown';
    lastUpdatedAt: string | null;
    eventsCount: number;
  }>;
}

@Injectable()
export class AdminDashboardService {
  constructor(
    @InjectRepository(UsageEvent)
    private readonly eventRepo: Repository<UsageEvent>,
    @InjectRepository(TraditionalCostBenchmark)
    private readonly benchmarkRepo: Repository<TraditionalCostBenchmark>,
  ) {}

  /**
   * Agrega costo real+estimado+mock desde usage_events, desglosado por
   * componente (content/audio/video/package/h5p/youtube/storage). Reusada
   * por getSummary() (todos los cursos en un rango de fechas) y por
   * getCourseCost() (un solo curso, sin filtro de fecha) — misma lógica de
   * COALESCE(real, estimated, mock) en ambos casos, un solo lugar de verdad.
   */
  private async buildCourseCostRows(opts: { from?: Date; to?: Date; courseId?: string }) {
    let qb = this.eventRepo
      .createQueryBuilder('e')
      .select('e.course_id', 'courseId')
      .addSelect("COALESCE(MAX(NULLIF(e.metadata->>'course_name', '')), MAX(NULLIF(e.metadata->>'courseName', '')), 'Curso sin nombre')", 'courseName')
      .addSelect('MAX(e.created_at)', 'lastUpdatedAt')
      .addSelect('COUNT(*)', 'eventsCount')
      .addSelect("COALESCE(SUM(CASE WHEN e.cost_type = 'real' THEN COALESCE(e.real_cost_usd, 0) ELSE 0 END), 0)", 'realCostUsd')
      .addSelect("COALESCE(SUM(CASE WHEN e.cost_type = 'estimated' THEN COALESCE(e.estimated_cost_usd, 0) ELSE 0 END), 0)", 'estimatedCostUsd')
      .addSelect("COALESCE(SUM(CASE WHEN e.cost_type = 'mock_zero' THEN COALESCE(e.estimated_cost_usd, 0) ELSE 0 END), 0)", 'mockCostUsd')
      .addSelect("COALESCE(SUM(CASE WHEN e.cost_type = 'unknown' THEN 1 ELSE 0 END), 0)", 'unknownCostEvents')
      .addSelect(
        "COALESCE(SUM(CASE WHEN COALESCE(e.component, '') = 'content' OR e.event_type LIKE 'ia_%' THEN COALESCE(e.real_cost_usd, e.estimated_cost_usd, CASE WHEN e.cost_type = 'mock_zero' THEN 0 ELSE NULL END) ELSE 0 END), 0)",
        'contentCostUsd',
      )
      .addSelect(
        "COALESCE(SUM(CASE WHEN COALESCE(e.component, '') IN ('audio', 'audiobook') OR e.event_type IN ('welcome_audio_generated', 'audiobook_generated') THEN COALESCE(e.real_cost_usd, e.estimated_cost_usd, CASE WHEN e.cost_type = 'mock_zero' THEN 0 ELSE NULL END) ELSE 0 END), 0)",
        'audioCostUsd',
      )
      .addSelect(
        "COALESCE(SUM(CASE WHEN COALESCE(e.component, '') = 'video' OR e.event_type LIKE 'video_%' THEN COALESCE(e.real_cost_usd, e.estimated_cost_usd, CASE WHEN e.cost_type = 'mock_zero' THEN 0 ELSE NULL END) ELSE 0 END), 0)",
        'videoCostUsd',
      )
      .addSelect(
        "COALESCE(SUM(CASE WHEN COALESCE(e.component, '') = 'package' OR e.event_type IN ('export_mbz', 'mbz_exported') THEN COALESCE(e.real_cost_usd, e.estimated_cost_usd, CASE WHEN e.cost_type = 'mock_zero' THEN 0 ELSE NULL END) ELSE 0 END), 0)",
        'packageCostUsd',
      )
      .addSelect(
        "COALESCE(SUM(CASE WHEN COALESCE(e.component, '') = 'h5p' THEN COALESCE(e.real_cost_usd, e.estimated_cost_usd, CASE WHEN e.cost_type = 'mock_zero' THEN 0 ELSE NULL END) ELSE 0 END), 0)",
        'h5pCostUsd',
      )
      .addSelect(
        "COALESCE(SUM(CASE WHEN COALESCE(e.component, '') = 'youtube' THEN COALESCE(e.real_cost_usd, e.estimated_cost_usd, CASE WHEN e.cost_type = 'mock_zero' THEN 0 ELSE NULL END) ELSE 0 END), 0)",
        'youtubeCostUsd',
      )
      .addSelect(
        "COALESCE(SUM(CASE WHEN COALESCE(e.component, '') = 'storage' THEN COALESCE(e.real_cost_usd, e.estimated_cost_usd, CASE WHEN e.cost_type = 'mock_zero' THEN 0 ELSE NULL END) ELSE 0 END), 0)",
        'storageCostUsd',
      )
      .addSelect("MAX(CASE WHEN e.failed = true THEN 1 ELSE 0 END)", 'hasFailure')
      .addSelect("MAX(CASE WHEN e.event_type IN ('course_production_completed', 'full_course_generation_completed') THEN 1 ELSE 0 END)", 'hasCompletedProduction')
      .addSelect("MAX(CASE WHEN e.event_type = 'full_course_generation_cancelled' THEN 1 ELSE 0 END)", 'hasCancelledProduction')
      .addSelect("STRING_AGG(DISTINCT COALESCE(e.mode, 'unknown'), ',')", 'modes');

    qb = (opts.from && opts.to)
      ? qb.where('e.created_at BETWEEN :from AND :to', { from: opts.from, to: opts.to })
      : qb.where('1=1');
    qb = qb.andWhere('e.course_id IS NOT NULL');
    if (opts.courseId) {
      qb = qb.andWhere('e.course_id = :courseId', { courseId: opts.courseId });
    }

    const courseCostRows = await qb
      .groupBy('e.course_id')
      .orderBy('MAX(e.created_at)', 'DESC')
      .getRawMany<{
        courseId: string;
        courseName: string;
        lastUpdatedAt: string;
        eventsCount: string;
        contentCostUsd: string;
        audioCostUsd: string;
        videoCostUsd: string;
        packageCostUsd: string;
        h5pCostUsd: string;
        youtubeCostUsd: string;
        storageCostUsd: string;
        realCostUsd: string;
        estimatedCostUsd: string;
        mockCostUsd: string;
        unknownCostEvents: string;
        hasFailure: string;
        hasCompletedProduction: string;
        hasCancelledProduction: string;
        modes: string;
      }>();

    return courseCostRows.map((row) => {
      const estimatedCostUsd = parseFloat(row.estimatedCostUsd ?? '0');
      const realCostUsd = parseFloat(row.realCostUsd ?? '0');
      const mockCostUsd = parseFloat(row.mockCostUsd ?? '0');
      const totalKnownCostUsd = estimatedCostUsd + realCostUsd + mockCostUsd;
      const unknownCostEvents = parseInt(row.unknownCostEvents ?? '0', 10);
      const hasFailure = Number(row.hasFailure ?? '0') > 0;
      const hasCompletedProduction = Number(row.hasCompletedProduction ?? '0') > 0;
      const hasCancelledProduction = Number(row.hasCancelledProduction ?? '0') > 0;
      const modes = String(row.modes ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      let status = 'En proceso';
      if (hasCompletedProduction) status = 'Listo';
      else if (hasCancelledProduction) status = 'Cancelado';
      else if (hasFailure) status = 'Con errores';
      let costStatus: 'real' | 'estimated' | 'mock' | 'mixed' | 'unknown' = 'unknown';
      if (unknownCostEvents > 0 && totalKnownCostUsd > 0) costStatus = 'mixed';
      else if (realCostUsd > 0 && (estimatedCostUsd > 0 || mockCostUsd > 0)) costStatus = 'mixed';
      else if (realCostUsd > 0) costStatus = 'real';
      else if (estimatedCostUsd > 0) costStatus = 'estimated';
      else if (
        modes.length > 0
        && modes.every((mode) => mode === 'mock' || mode === 'dry_run')
        && (mockCostUsd > 0 || modes.some((mode) => mode === 'mock' || mode === 'dry_run'))
      ) costStatus = 'mock';

      const costSource: 'estimated' | 'real' | 'mixed' | 'mock' | null =
        costStatus === 'real' ? 'real'
          : costStatus === 'estimated' ? 'estimated'
            : costStatus === 'mock' ? 'mock'
              : costStatus === 'mixed' ? 'mixed'
                : null;

      let mode: 'real' | 'mock' | 'dry_run' | 'mixed' | 'unknown' = 'unknown';
      if (modes.length === 1 && ['real', 'mock', 'dry_run', 'unknown'].includes(modes[0])) {
        mode = modes[0] as typeof mode;
      } else if (modes.length > 1) {
        mode = 'mixed';
      }

      const totalCostUsd = unknownCostEvents > 0 && totalKnownCostUsd === 0
        ? null
        : Number(totalKnownCostUsd.toFixed(6));
      const hasMissingCostEvents = unknownCostEvents > 0;

      return {
        courseId: row.courseId,
        courseName: row.courseName || 'Curso sin nombre',
        status,
        totalCostUsd,
        estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
        realCostUsd: Number(realCostUsd.toFixed(6)),
        mockCostUsd: Number(mockCostUsd.toFixed(6)),
        unknownCostUsd: hasMissingCostEvents ? null : 0,
        costStatus,
        costSource,
        contentCostUsd: Number(parseFloat(row.contentCostUsd ?? '0').toFixed(6)),
        audioCostUsd: Number(parseFloat(row.audioCostUsd ?? '0').toFixed(6)),
        videoCostUsd: Number(parseFloat(row.videoCostUsd ?? '0').toFixed(6)),
        packageCostUsd: Number(parseFloat(row.packageCostUsd ?? '0').toFixed(6)),
        h5pCostUsd: Number(parseFloat(row.h5pCostUsd ?? '0').toFixed(6)),
        youtubeCostUsd: Number(parseFloat(row.youtubeCostUsd ?? '0').toFixed(6)),
        storageCostUsd: Number(parseFloat(row.storageCostUsd ?? '0').toFixed(6)),
        hasMissingCostEvents,
        mode,
        lastUpdatedAt: row.lastUpdatedAt || null,
        eventsCount: parseInt(row.eventsCount ?? '0', 10),
      };
    });
  }

  /**
   * Costo real+estimado de UN curso (dueño del curso, no admin). Usa la misma
   * agregación que el panel Admin (buildCourseCostRows), filtrada a un solo
   * course_id — así ambos lugares siempre muestran el mismo número.
   */
  async getCourseCost(courseId: string) {
    const rows = await this.buildCourseCostRows({ courseId });
    if (rows[0]) return rows[0];
    return {
      courseId,
      courseName: null,
      status: 'unknown',
      totalCostUsd: null,
      estimatedCostUsd: 0,
      realCostUsd: 0,
      mockCostUsd: 0,
      unknownCostUsd: null,
      costStatus: 'unknown' as const,
      costSource: null,
      contentCostUsd: 0,
      audioCostUsd: 0,
      videoCostUsd: 0,
      packageCostUsd: 0,
      h5pCostUsd: 0,
      youtubeCostUsd: 0,
      storageCostUsd: 0,
      hasMissingCostEvents: false,
      mode: 'unknown' as const,
      lastUpdatedAt: null,
      eventsCount: 0,
    };
  }

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
      .andWhere("e.event_type IN ('video_job_completed', 'video_generation_completed')")
      .getCount();

    const videosYouTube = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type = 'youtube_upload_completed'")
      .getCount();

    const videosFailed = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type IN ('video_job_failed', 'video_generation_failed', 'youtube_upload_failed')")
      .getCount();

    const videoCostStats = await this.eventRepo
      .createQueryBuilder('e')
      .select("COALESCE(SUM(CASE WHEN COALESCE(e.component, '') = 'video' THEN COALESCE(e.real_cost_usd, e.estimated_cost_usd, 0) ELSE 0 END), 0)", 'videosCost')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .getRawOne<{ videosCost: string }>();

    const videosCostUsd = parseFloat(videoCostStats?.videosCost ?? '0');

    // ── 5. Audio ──────────────────────────────────────────────────────────────
    const welcomeAudioCount = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type IN ('welcome_audio_generated', 'welcome_audio_completed')")
      .getCount();

    const audiobookCount = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type IN ('audiobook_generated', 'audiobook_completed')")
      .getCount();

    const audioCostStats = await this.eventRepo
      .createQueryBuilder('e')
      .select("COALESCE(SUM(CASE WHEN COALESCE(e.component, '') IN ('audio', 'audiobook') THEN COALESCE(e.real_cost_usd, e.estimated_cost_usd, 0) ELSE 0 END), 0)", 'audioCost')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .getRawOne<{ audioCost: string }>();

    const audioCostUsd = parseFloat(audioCostStats?.audioCost ?? '0');

    // ── 6. Producción completa ────────────────────────────────────────────────
    const productionCompleted = await this.eventRepo
      .createQueryBuilder('e')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type IN ('course_production_completed', 'full_course_generation_completed')")
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
      .select("COALESCE(SUM(CASE WHEN e.cost_type = 'estimated' THEN COALESCE(e.estimated_cost_usd, 0) ELSE 0 END), 0)", 'estimatedTotalCost')
      .addSelect("COALESCE(SUM(CASE WHEN e.cost_type = 'real' THEN COALESCE(e.real_cost_usd, 0) ELSE 0 END), 0)", 'realTotalCost')
      .addSelect("COALESCE(SUM(CASE WHEN e.cost_type = 'mock_zero' THEN COALESCE(e.estimated_cost_usd, 0) ELSE 0 END), 0)", 'mockTotalCost')
      .addSelect("COALESCE(SUM(CASE WHEN e.cost_type = 'unknown' THEN 1 ELSE 0 END), 0)", 'unknownEvents')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .getRawOne<{ estimatedTotalCost: string; realTotalCost: string; mockTotalCost: string; unknownEvents: string }>();

    const estimatedTotalCostUsd = parseFloat(totalCostStats?.estimatedTotalCost ?? '0');
    const realTotalCostUsd = parseFloat(totalCostStats?.realTotalCost ?? '0');
    const mockTotalCostUsd = parseFloat(totalCostStats?.mockTotalCost ?? '0');
    const totalCostUsd = estimatedTotalCostUsd + realTotalCostUsd + mockTotalCostUsd;
    const unknownEvents = parseInt(totalCostStats?.unknownEvents ?? '0', 10);

    // ── 9a. Costo por proveedor ───────────────────────────────────────────────
    const costByProviderRaw = await this.eventRepo
      .createQueryBuilder('e')
      .select("COALESCE(e.provider, e.ai_provider, 'otros')", 'provider')
      .addSelect(
        "COALESCE(SUM(COALESCE(e.real_cost_usd, e.estimated_cost_usd, CASE WHEN e.cost_type = 'mock_zero' THEN 0 ELSE NULL END)), 0)",
        'cost_usd',
      )
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .groupBy("COALESCE(e.provider, e.ai_provider, 'otros')")
      .getRawMany<{ provider: string; cost_usd: string }>();

    const costByProvider = costByProviderRaw.map(r => ({
      provider: r.provider ?? 'otros',
      cost_usd: parseFloat(r.cost_usd ?? '0'),
    }));

    // ── 9b. Produccion por dia ────────────────────────────────────────────────
    const productionTrendRaw = await this.eventRepo
      .createQueryBuilder('e')
      .select('DATE(e.created_at)', 'date')
      .addSelect('COUNT(*)', 'count')
      .where('e.created_at BETWEEN :from AND :to', { from, to })
      .andWhere("e.event_type IN ('course_production_completed', 'full_course_generation_completed')")
      .groupBy('DATE(e.created_at)')
      .orderBy('DATE(e.created_at)', 'ASC')
      .getRawMany<{ date: string; count: string }>();

    const productionTrend = productionTrendRaw.map(r => ({
      date:  r.date,
      count: parseInt(r.count ?? '0', 10),
    }));

    // ── 10. Ahorro vs. método tradicional ────────────────────────────────────
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

    // ── 11. Costos por curso ──────────────────────────────────────────────────
    const courseCosts = await this.buildCourseCostRows({ from, to });

    const coursesWithCostCount = courseCosts.filter((course) => (course.totalCostUsd ?? 0) > 0).length;
    const coursesWithoutCostCount = Math.max(0, courseCosts.length - coursesWithCostCount);
    const coursesWithUnknownCostCount = courseCosts.filter((course) => course.hasMissingCostEvents).length;
    const averageEstimatedCostUsd = coursesWithCostCount > 0
      ? courseCosts.reduce((sum, course) => sum + course.estimatedCostUsd, 0) / coursesWithCostCount
      : 0;

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
      total_estimated_cost_usd:   Number(estimatedTotalCostUsd.toFixed(6)),
      costs: {
        estimated_total_usd: Number(estimatedTotalCostUsd.toFixed(6)),
        real_total_usd: Number(realTotalCostUsd.toFixed(6)),
        mock_total_usd: Number(mockTotalCostUsd.toFixed(6)),
        unknown_events: unknownEvents,
      },
      traditional_equivalent_usd: Number(traditionalEquivalentUsd.toFixed(2)),
      savings_usd:                Number(savingsUsd.toFixed(2)),
      failures: {
        total: failedEvents,
      },
      costByProvider,
      productionTrend,
      courseCostSummary: {
        totalEstimatedCostUsd: Number(estimatedTotalCostUsd.toFixed(6)),
        totalRealCostUsd: Number(realTotalCostUsd.toFixed(6)),
        totalMockCostUsd: Number(mockTotalCostUsd.toFixed(6)),
        averageEstimatedCostUsd: Number(averageEstimatedCostUsd.toFixed(6)),
        coursesWithCostCount,
        coursesWithoutCostCount,
        coursesWithUnknownCostCount,
      },
      courseCosts,
    };
  }
}
