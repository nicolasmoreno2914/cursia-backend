import { IsOptional, IsObject } from 'class-validator';

/**
 * Confirmación humana de un perfil pending_review (Fase 2).
 * Permite sobreescribir cualquier campo extraído antes de activar.
 */
export class ConfirmBrandProfileDto {
  @IsOptional()
  @IsObject()
  palette?: Record<string, any>;

  @IsOptional()
  @IsObject()
  typography?: Record<string, any>;

  @IsOptional()
  @IsObject()
  usageRules?: Record<string, any>;
}
