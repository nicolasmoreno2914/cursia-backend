import { IsUUID } from 'class-validator';

/**
 * Fase 8 (F8-BE): body de `POST …/manifest/runs` para crear el run B
 * aplicando el plan de invalidación desde el run A (`fromRun`). El contexto
 * del curso, el videoMode y el videoDelivery se HEREDAN de A (congelados);
 * cualquier otro campo es 400 (forbidNonWhitelisted).
 */
export class FromRunDto {
  @IsUUID()
  fromRun: string;
}

export function isFromRunRequest(body: unknown): body is FromRunDto {
  return !!body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'fromRun');
}
