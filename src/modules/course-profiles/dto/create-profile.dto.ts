import { IsInt, IsObject, IsOptional, Min } from 'class-validator';

/**
 * POST /courses/:courseId/profiles/:kind. `data` es el perfil COMPLETO; lo
 * valida la lógica pura de course-profiles.ts (códigos de error explícitos).
 * `expectedVersion` (opcional): concurrencia optimista — la versión vigente
 * que el cliente leyó (0 = "no había ninguno"); si no coincide → 409.
 */
export class CreateProfileDto {
  @IsObject()
  data: Record<string, unknown>;

  @IsInt()
  @Min(0)
  @IsOptional()
  expectedVersion?: number;
}
