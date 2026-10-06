import { IsInt, IsString, Matches, Min } from 'class-validator';

// Fase 2 · «Aplicar diseño»: la propuesta del distribuidor que el docente vio (huella) pasa a la estructura real.
export class ApplyDistributionDto {
  @IsInt()
  @Min(0)
  expectedCounter: number;

  /** distribution.proposalSha256 del dry-run que vio el docente (el servidor la recalcula y exige la misma). */
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  proposalSha256: string;
}
