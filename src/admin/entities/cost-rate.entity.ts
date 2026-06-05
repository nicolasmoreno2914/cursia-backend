/* ══════════════════════════════════════════════════════════════
   cost-rate.entity.ts — Tarifas de coste por proveedor/modelo
   ══════════════════════════════════════════════════════════════

   Tabla de precios viva. Actualizar precios = solo cambiar filas
   aquí, sin tocar código de negocio.

   unit_type:
     'per_1k_input_tokens'   → coste por 1 000 tokens de entrada
     'per_1k_output_tokens'  → coste por 1 000 tokens de salida
     'per_video'             → coste por video generado
     'per_request'           → coste fijo por llamada
     'per_job'               → coste por job (Video Engine)
   ══════════════════════════════════════════════════════════════ */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('cost_rates')
@Index(['provider', 'service', 'model', 'unitType'], { unique: false })
export class CostRate {
  @PrimaryGeneratedColumn()
  id: number;

  /** Proveedor del servicio (ej: 'anthropic', 'openai', 'video_engine'). */
  @Column({ length: 50 })
  provider: string;

  /** Nombre interno del servicio (ej: 'chat_completion', 'video_generation'). */
  @Column({ length: 80 })
  service: string;

  /** Modelo específico (ej: 'claude-3-5-sonnet-20241022'). null = aplica a todo el servicio. */
  @Column({ length: 100, nullable: true })
  model: string;

  /** Tipo de unidad de medida. */
  @Column({ name: 'unit_type', length: 30 })
  unitType: string;

  /** Precio en USD por la unidad indicada. */
  @Column({ name: 'rate_usd', type: 'numeric', precision: 12, scale: 8 })
  rateUsd: number;

  /** ¿Esta tarifa está activa? Solo la activa se usa para calcular costes. */
  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /** Fecha desde la que aplica esta tarifa (para histórico). */
  @Column({ name: 'effective_from', type: 'date', nullable: true })
  effectiveFrom: string;

  /** Notas internas sobre la tarifa. */
  @Column({ type: 'text', nullable: true })
  notes: string;

  /** Fuente de esta tarifa: precio configurado, listado público del proveedor, etc. */
  @Column({ length: 40, nullable: true, default: 'configured_rate' })
  source: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
