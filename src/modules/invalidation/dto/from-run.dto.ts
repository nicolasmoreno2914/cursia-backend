import { IsOptional, IsUUID, Matches } from 'class-validator';

/**
 * Fase 8 (F8-BE): body de `POST …/manifest/runs` para crear el run B
 * aplicando el plan de invalidación desde el run A (`fromRun`). El contexto
 * del curso, el videoMode y el videoDelivery se HEREDAN de A (congelados);
 * cualquier otro campo es 400 (forbidNonWhitelisted).
 */
export class FromRunDto {
  @IsUUID()
  fromRun: string;

  /**
   * r62 (I2): «Autorizar y aplicar» — huella del estimado del plan que vio el usuario (POST …/runs/from-run-preview).
   * Con ella, dentro de la política, la firma del usuario autoriza el run B (sin admin). Sin ella: el camino de siempre.
   */
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  estimateHash?: string;
}

export function isFromRunRequest(body: unknown): body is FromRunDto {
  return !!body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'fromRun');
}
