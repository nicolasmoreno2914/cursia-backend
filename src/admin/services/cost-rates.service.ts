/* ══════════════════════════════════════════════════════════════
   cost-rates.service.ts — Cálculo de costes por evento
   ══════════════════════════════════════════════════════════════

   Resuelve la tarifa activa para un proveedor/servicio/modelo
   y calcula el coste estimado dado un evento.

   Diseño:
   - getActiveRate() → tarifa más específica (con modelo primero,
     luego sin modelo). Devuelve null si no hay tarifa.
   - estimateCostFromEvent() → nunca lanza excepción. Devuelve
     null si no hay suficiente información para calcular.
   ══════════════════════════════════════════════════════════════ */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CostRate } from '../entities/cost-rate.entity';

export interface EventCostInput {
  provider?: string;
  service?: string;
  model?: string;
  tokensInput?: number;
  tokensOutput?: number;
  videoCount?: number;
}

@Injectable()
export class CostRatesService {
  constructor(
    @InjectRepository(CostRate)
    private readonly costRateRepo: Repository<CostRate>,
  ) {}

  /**
   * Busca la tarifa activa más específica.
   * Prioridad: (provider + service + model) → (provider + service, model=null)
   */
  async getActiveRate(
    provider: string,
    service: string,
    model: string | null,
    unitType: string,
  ): Promise<CostRate | null> {
    // Intento 1: tarifa específica con modelo
    if (model) {
      const rate = await this.costRateRepo.findOne({
        where: { provider, service, model, unitType, isActive: true },
      });
      if (rate) return rate;
    }

    // Intento 2: tarifa genérica sin modelo
    const generic = await this.costRateRepo
      .createQueryBuilder('cr')
      .where('cr.provider = :provider', { provider })
      .andWhere('cr.service = :service', { service })
      .andWhere('cr.unit_type = :unitType', { unitType })
      .andWhere('cr.is_active = true')
      .andWhere('cr.model IS NULL')
      .getOne();

    return generic ?? null;
  }

  /**
   * Calcula el coste estimado en USD para un evento.
   * Devuelve null si no hay tarifa o no hay datos suficientes.
   * NUNCA lanza excepción — el evento se guarda aunque el coste sea null.
   */
  async estimateCostFromEvent(input: EventCostInput): Promise<number | null> {
    try {
      const { provider, service, model, tokensInput, tokensOutput, videoCount } = input;
      if (!provider || !service) return null;

      let total = 0;
      let hasValue = false;

      // ── Tokens de entrada ──────────────────────────────────────────
      if (tokensInput && tokensInput > 0) {
        const rate = await this.getActiveRate(provider, service, model ?? null, 'per_1k_input_tokens');
        if (rate) {
          total += (tokensInput / 1000) * Number(rate.rateUsd);
          hasValue = true;
        }
      }

      // ── Tokens de salida ───────────────────────────────────────────
      if (tokensOutput && tokensOutput > 0) {
        const rate = await this.getActiveRate(provider, service, model ?? null, 'per_1k_output_tokens');
        if (rate) {
          total += (tokensOutput / 1000) * Number(rate.rateUsd);
          hasValue = true;
        }
      }

      // ── Videos generados ──────────────────────────────────────────
      if (videoCount && videoCount > 0) {
        const rate = await this.getActiveRate(provider, service, model ?? null, 'per_video');
        if (rate) {
          total += videoCount * Number(rate.rateUsd);
          hasValue = true;
        }
      }

      // ── Coste por request/job (fixed) ──────────────────────────────
      if (!hasValue) {
        const rate =
          (await this.getActiveRate(provider, service, model ?? null, 'per_request')) ??
          (await this.getActiveRate(provider, service, model ?? null, 'per_job'));
        if (rate) {
          total += Number(rate.rateUsd);
          hasValue = true;
        }
      }

      return hasValue ? total : null;
    } catch {
      // No bloquear el guardado del evento si hay error de DB
      return null;
    }
  }
}
