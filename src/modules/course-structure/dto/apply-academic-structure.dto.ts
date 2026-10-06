import { IsBoolean, IsIn, IsInt, IsOptional, Min } from 'class-validator';

// LOOP 8.0: POST /courses/:courseId/modules/apply-academic-structure — reemplaza la estructura con la del
// contexto académico GUARDADO (versión `contextVersion`). `confirmReplace` = el docente confirmó perder sus cambios
// o volver a armar una estructura ya confirmada (sin él, esos casos responden 409 sin cambiar nada).
export class ApplyAcademicStructureDto {
  @IsInt()
  @Min(0)
  expectedCounter: number;

  @IsInt()
  @Min(1)
  contextVersion: number;

  @IsOptional()
  @IsBoolean()
  confirmReplace?: boolean;
}

// LOOP 8.0: POST /courses/:courseId/modules/structure-origin — el editor avisa que terminó de aplicar la propuesta de la
// IA (con el contador resultante). Solo `ai_proposal`: el origen `academic_context` lo escribe únicamente el backend.
export class RecordStructureOriginDto {
  @IsInt()
  @Min(0)
  expectedCounter: number;

  @IsIn(['ai_proposal'])
  source: 'ai_proposal';
}
