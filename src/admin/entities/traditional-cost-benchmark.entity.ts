/* ══════════════════════════════════════════════════════════════
   traditional-cost-benchmark.entity.ts — Base de comparación
   ══════════════════════════════════════════════════════════════

   Define cuánto costaría cada unidad de contenido usando métodos
   tradicionales (freelancer, agencia, estudio de grabación, etc.).

   Se usa para calcular el ahorro:
     savings = Σ(benchmark.typical_cost_usd × quantity) − cursia_cost

   Ejemplo:
     benchmark 'course_creation' → typical_cost_usd = 2500 USD
     quantity = 3 cursos creados en el período
     savings_gross = 7500 USD
   ══════════════════════════════════════════════════════════════ */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('traditional_cost_benchmarks')
export class TraditionalCostBenchmark {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Identificador único del benchmark.
   * Vinculado a event_types o categorías:
   * 'course_creation', 'video_production', 'quiz_design',
   * 'instructional_design_hour', 'voiceover_minute', etc.
   */
  @Column({ name: 'benchmark_key', length: 80, unique: true })
  benchmarkKey: string;

  /** Nombre legible para el dashboard. */
  @Column({ length: 150 })
  label: string;

  /** Descripción del método tradicional de referencia. */
  @Column({ type: 'text', nullable: true })
  description: string;

  /** Coste típico en USD por unidad (método tradicional). */
  @Column({ name: 'typical_cost_usd', type: 'numeric', precision: 10, scale: 2 })
  typicalCostUsd: number;

  /** Unidad de medida (ej: 'por curso', 'por video', 'por hora', 'por minuto'). */
  @Column({ length: 50, nullable: true })
  unit: string;

  /**
   * Fuente del benchmark (freelancer, agencia, mercado, etc.).
   * Para transparencia y auditoría.
   */
  @Column({ length: 200, nullable: true })
  source: string;

  /** ¿Está activo este benchmark? */
  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
