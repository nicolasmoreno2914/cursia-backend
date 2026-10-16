/* ══════════════════════════════════════════════════════════════
   admin-dashboard.service.ts — Métricas agregadas del dashboard
   ══════════════════════════════════════════════════════════════

   FinOps P0 (2026-10-16): TODO el dinero sale del ledger V2 vía
   CostReadService (generation_cost_events → CostReadService → API →
   Dashboard). `usage_events` (tabla antigua, forjable desde el
   navegador con POST /events, sin reservas) se usa SOLO para contar
   actividad no financiera (eventos, cursos creados, videos, audios,
   exportaciones); nunca se lee ninguna de sus columnas de costo.

   Eliminado de la respuesta: «Costo total = suma de estimados»,
   costByProvider/courseCostSummary/courseCosts calculados desde
   usage_events y el «ahorro vs. producción tradicional» (un número
   inventado contra un costo fijo: no es dinero).
   ══════════════════════════════════════════════════════════════ */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CostReadService, CourseCost, CostSummary, PeriodSummary } from '../../modules/finops/cost-read.service';

export interface DashboardSummary {
  period: { from: string; to: string };
  /** Dinero oficial del período (ledger V2; strings decimales con moneda). Las filas por curso van en courseCosts. */
  money: Omit<PeriodSummary, 'courses'>;
  events: { total: number; failed: number };
  courses: { created: number };
  /** Tokens medidos por el ledger (cargos finales de Anthropic pagados por Cursia en el período). */
  tokens: { input_total: number; output_total: number };
  videos: { requested: number; generated: number; uploaded_youtube: number; failed: number };
  audio: { welcome_generated: number; audiobooks_generated: number };
  production: { completed: number };
  exports: { mbz_total: number };
  failures: { total: number };
  /** Cursos completados por día (UTC) en el período — actividad, no dinero. */
  productionTrend: Array<{ date: string; count: number }>;
  /** Una fila por curso con gasto en el período (montos SOLO del período). */
  courseCosts: Array<{
    courseId: string;
    frontendCourseId: string | null;
    courseName: string;
    status: string | null;
    money: CostSummary;
    lastUpdatedAt: string | null;
    eventsCount: number;
  }>;
}

/** Conteo de actividad (no financiera) de usage_events por tipo de evento. */
const ACTIVITY_COUNTS: Record<string, string> = {
  total: `true`,
  failed: `failed = true`,
  courses_created: `event_type = 'course_created'`,
  videos_requested: `event_type in ('video_job_requested', 'video_batch_requested')`,
  videos_generated: `event_type in ('video_job_completed', 'video_generation_completed')`,
  videos_youtube: `event_type = 'youtube_upload_completed'`,
  videos_failed: `event_type in ('video_job_failed', 'video_generation_failed', 'youtube_upload_failed')`,
  welcome_audio: `event_type in ('welcome_audio_generated', 'welcome_audio_completed')`,
  audiobooks: `event_type in ('audiobook_generated', 'audiobook_completed')`,
  production_completed: `event_type in ('course_production_completed', 'full_course_generation_completed')`,
  mbz: `event_type in ('export_mbz', 'mbz_exported')`,
};

@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly costRead: CostReadService,
  ) {}

  /**
   * Costo de UN curso (GET /courses/:id/cost, el dueño ya verificado por CoursesService): el ledger de TODOS sus
   * runs + el desglose por run. `money.committed` es el total del curso; actual/reserved por separado.
   */
  async getCourseCost(courseId: number): Promise<{
    courseId: string; courseName: string | null; status: string | null; costSource: 'ledger_v2'; money: CourseCost;
    lastUpdatedAt: string | null; eventsCount: number;
  }> {
    const money = await this.costRead.courseCost(courseId);
    return {
      courseId: String(courseId),
      courseName: money.courseName,
      status: money.courseStatus,
      costSource: 'ledger_v2',
      money,
      lastUpdatedAt: money.lastEventAt,
      eventsCount: money.counts.events,
    };
  }

  async getSummary(from: Date, to: Date): Promise<DashboardSummary> {
    const { courses, ...money } = await this.costRead.periodSummary(from, to);
    const activity = await this.activity(from, to);
    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      money,
      events: { total: activity.counts.total, failed: activity.counts.failed },
      courses: { created: activity.counts.courses_created },
      tokens: { input_total: money.tokens.input, output_total: money.tokens.output },
      videos: {
        requested: activity.counts.videos_requested,
        generated: activity.counts.videos_generated,
        uploaded_youtube: activity.counts.videos_youtube,
        failed: activity.counts.videos_failed,
      },
      audio: { welcome_generated: activity.counts.welcome_audio, audiobooks_generated: activity.counts.audiobooks },
      production: { completed: activity.counts.production_completed },
      exports: { mbz_total: activity.counts.mbz },
      failures: { total: activity.counts.failed },
      productionTrend: activity.trend,
      courseCosts: courses.map((c) => ({
        courseId: String(c.courseId),
        frontendCourseId: c.frontendCourseId,
        courseName: c.courseName || 'Curso sin nombre',
        status: c.courseStatus,
        money: c.money,
        lastUpdatedAt: c.money.lastEventAt,
        eventsCount: c.money.counts.events,
      })),
    };
  }

  /** Actividad no financiera de usage_events en [from, to) — solo event_type / failed / created_at. */
  private async activity(from: Date, to: Date): Promise<{ counts: Record<string, number>; trend: Array<{ date: string; count: number }> }> {
    const zero: Record<string, number> = Object.fromEntries(Object.keys(ACTIVITY_COUNTS).map((k) => [k, 0]));
    try {
      const cols = Object.entries(ACTIVITY_COUNTS).map(([k, w]) => `count(*) filter (where ${w})::int as ${k}`).join(', ');
      const [row] = await this.dataSource.query(
        `select ${cols} from public.usage_events where created_at >= $1 and created_at < $2`,
        [from.toISOString(), to.toISOString()],
      );
      const trend = await this.dataSource.query(
        `select to_char((created_at at time zone 'UTC')::date, 'YYYY-MM-DD') as date, count(*)::int as count
           from public.usage_events
          where created_at >= $1 and created_at < $2 and ${ACTIVITY_COUNTS.production_completed}
          group by 1 order by 1`,
        [from.toISOString(), to.toISOString()],
      );
      const counts: Record<string, number> = { ...zero };
      for (const k of Object.keys(ACTIVITY_COUNTS)) counts[k] = Number(row?.[k] ?? 0);
      return { counts, trend: trend.map((r: any) => ({ date: String(r.date), count: Number(r.count) })) };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '42P01') return { counts: zero, trend: [] }; // sin tabla antigua: la actividad es 0; el dinero no depende de ella
      throw err;
    }
  }
}
