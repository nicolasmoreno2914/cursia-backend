/* ══════════════════════════════════════════════════════════════
   admin-seed.service.ts — Seed idempotente para tablas admin
   ══════════════════════════════════════════════════════════════

   Corre en onModuleInit → se ejecuta en cada arranque del backend.
   Verifica existencia antes de insertar → nunca duplica registros.

   Para re-sembrar desde cero: truncar las tablas en PostgreSQL.
   ══════════════════════════════════════════════════════════════ */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CostRate } from '../entities/cost-rate.entity';
import { TraditionalCostBenchmark } from '../entities/traditional-cost-benchmark.entity';

// ── Datos de siembra ─────────────────────────────────────────────────────────

const COST_RATES_SEED: Omit<CostRate, 'id' | 'createdAt' | 'updatedAt'>[] = [
  // ── Anthropic — Claude 3.5 Sonnet ────────────────────────────────────────
  {
    provider: 'anthropic',
    service:  'chat_completion',
    model:    'claude-3-5-sonnet-20241022',
    unitType: 'per_1k_input_tokens',
    rateUsd:  0.003,
    isActive: true,
    effectiveFrom: '2024-10-22',
    notes: 'Claude 3.5 Sonnet — precio entrada Anthropic API',
  },
  {
    provider: 'anthropic',
    service:  'chat_completion',
    model:    'claude-3-5-sonnet-20241022',
    unitType: 'per_1k_output_tokens',
    rateUsd:  0.015,
    isActive: true,
    effectiveFrom: '2024-10-22',
    notes: 'Claude 3.5 Sonnet — precio salida Anthropic API',
  },
  // ── Anthropic — Claude Sonnet 4 / claude-sonnet-4-6 ──────────────────────
  {
    provider: 'anthropic',
    service:  'chat_completion',
    model:    'claude-sonnet-4-5',
    unitType: 'per_1k_input_tokens',
    rateUsd:  0.003,
    isActive: true,
    effectiveFrom: '2025-01-01',
    notes: 'Claude Sonnet 4.5 — precio entrada (estimado)',
  },
  {
    provider: 'anthropic',
    service:  'chat_completion',
    model:    'claude-sonnet-4-5',
    unitType: 'per_1k_output_tokens',
    rateUsd:  0.015,
    isActive: true,
    effectiveFrom: '2025-01-01',
    notes: 'Claude Sonnet 4.5 — precio salida (estimado)',
  },
  {
    provider: 'anthropic',
    service:  'chat_completion',
    model:    'claude-sonnet-4-6',
    unitType: 'per_1k_input_tokens',
    rateUsd:  0.003,
    isActive: true,
    effectiveFrom: '2025-01-01',
    notes: 'Claude Sonnet 4.6 — precio entrada (estimado)',
  },
  {
    provider: 'anthropic',
    service:  'chat_completion',
    model:    'claude-sonnet-4-6',
    unitType: 'per_1k_output_tokens',
    rateUsd:  0.015,
    isActive: true,
    effectiveFrom: '2025-01-01',
    notes: 'Claude Sonnet 4.6 — precio salida (estimado)',
  },
  // ── Anthropic — Claude 3 Haiku (más económico) ────────────────────────────
  {
    provider: 'anthropic',
    service:  'chat_completion',
    model:    'claude-3-haiku-20240307',
    unitType: 'per_1k_input_tokens',
    rateUsd:  0.00025,
    isActive: true,
    effectiveFrom: '2024-03-07',
    notes: 'Claude 3 Haiku — precio entrada',
  },
  {
    provider: 'anthropic',
    service:  'chat_completion',
    model:    'claude-3-haiku-20240307',
    unitType: 'per_1k_output_tokens',
    rateUsd:  0.00125,
    isActive: true,
    effectiveFrom: '2024-03-07',
    notes: 'Claude 3 Haiku — precio salida',
  },
  // ── Anthropic — fallback genérico sin modelo ──────────────────────────────
  // Se aplica cuando ai_model no está en ninguna tarifa específica.
  {
    provider: 'anthropic',
    service:  'chat_completion',
    model:    null,
    unitType: 'per_1k_input_tokens',
    rateUsd:  0.003,
    isActive: true,
    effectiveFrom: '2024-01-01',
    notes: 'Anthropic chat_completion — tarifa genérica entrada (fallback)',
  },
  {
    provider: 'anthropic',
    service:  'chat_completion',
    model:    null,
    unitType: 'per_1k_output_tokens',
    rateUsd:  0.015,
    isActive: true,
    effectiveFrom: '2024-01-01',
    notes: 'Anthropic chat_completion — tarifa genérica salida (fallback)',
  },
  // ── Video Engine IA — por video generado ──────────────────────────────────
  {
    provider: 'video_engine',
    service:  'video_generation',
    model:    null,
    unitType: 'per_video',
    rateUsd:  0.50,
    isActive: true,
    effectiveFrom: '2025-01-01',
    notes: 'Video Engine IA — coste estimado por video generado (ajustar según plan)',
  },
  // ── ElevenLabs — audio por job ────────────────────────────────────────────
  {
    provider: 'elevenlabs',
    service:  'audio_generation',
    model:    null,
    unitType: 'per_job',
    rateUsd:  0.03,
    isActive: true,
    effectiveFrom: '2025-01-01',
    notes: 'ElevenLabs — coste estimado por audio generado (bienvenida o audiolibro cap.)',
  },
];

const BENCHMARKS_SEED: Omit<TraditionalCostBenchmark, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    benchmarkKey: 'course_creation',
    label: 'Creación de curso completo',
    description: 'Diseño instruccional + contenido + multimedia básica por un freelancer/agencia',
    typicalCostUsd: 2500,
    unit: 'por curso',
    source: 'Promedio mercado eLearning latinoamericano 2024 (Freelancer.com, Workana)',
    isActive: true,
  },
  {
    benchmarkKey: 'video_production',
    label: 'Producción de video educativo',
    description: 'Guión + grabación + edición por estudio/freelancer. Video tipo talking-head 5 min.',
    typicalCostUsd: 300,
    unit: 'por video',
    source: 'Promedio Workana/Fiverr LATAM 2024',
    isActive: true,
  },
  {
    benchmarkKey: 'export_mbz',
    label: 'Empaquetado MBZ para Moodle',
    description: 'Configuración técnica y empaquetado de curso para importar en Moodle',
    typicalCostUsd: 150,
    unit: 'por exportación',
    source: 'Estimado basado en tarifa hora consultoría Moodle (2h × $75/h)',
    isActive: true,
  },
];

// ────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AdminSeedService implements OnModuleInit {
  private readonly logger = new Logger(AdminSeedService.name);

  constructor(
    @InjectRepository(CostRate)
    private readonly costRateRepo: Repository<CostRate>,
    @InjectRepository(TraditionalCostBenchmark)
    private readonly benchmarkRepo: Repository<TraditionalCostBenchmark>,
  ) {}

  async onModuleInit() {
    await this._seedCostRates();
    await this._seedBenchmarks();
  }

  /** Siembra cost_rates — idempotente por (provider, service, model, unit_type). */
  private async _seedCostRates() {
    let inserted = 0;

    for (const seed of COST_RATES_SEED) {
      // ⚠️  Null safety: model puede ser NULL en la DB.
      // TypeORM WHERE con model=undefined omite el campo. Usamos raw query para IS NULL.
      const qb = this.costRateRepo
        .createQueryBuilder('cr')
        .where('cr.provider = :provider', { provider: seed.provider })
        .andWhere('cr.service = :service', { service: seed.service })
        .andWhere('cr.unit_type = :unitType', { unitType: seed.unitType });

      if (seed.model) {
        qb.andWhere('cr.model = :model', { model: seed.model });
      } else {
        qb.andWhere('cr.model IS NULL');
      }

      const existing = await qb.getOne();

      if (!existing) {
        await this.costRateRepo.save(this.costRateRepo.create(seed as any));
        inserted++;
      }
    }

    if (inserted > 0) {
      this.logger.log(`cost_rates: ${inserted} tarifa(s) sembrada(s)`);
    } else {
      this.logger.debug('cost_rates: ya sembradas, sin cambios');
    }
  }

  /** Siembra traditional_cost_benchmarks — idempotente por benchmark_key. */
  private async _seedBenchmarks() {
    let inserted = 0;

    for (const seed of BENCHMARKS_SEED) {
      const existing = await this.benchmarkRepo.findOne({
        where: { benchmarkKey: seed.benchmarkKey },
      });

      if (!existing) {
        await this.benchmarkRepo.save(this.benchmarkRepo.create(seed));
        inserted++;
      }
    }

    if (inserted > 0) {
      this.logger.log(`traditional_cost_benchmarks: ${inserted} benchmark(s) sembrado(s)`);
    } else {
      this.logger.debug('traditional_cost_benchmarks: ya sembrados, sin cambios');
    }
  }
}
