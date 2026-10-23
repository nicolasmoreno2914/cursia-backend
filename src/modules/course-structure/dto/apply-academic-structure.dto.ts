import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';

/** Fase 3: forma elegida (N módulos × M capítulos de contenido); validación de entrada, no una capacidad. */
export class StructureShapeDto {
  @IsInt()
  @Min(1)
  @Max(50)
  modules: number;

  @IsInt()
  @Min(1)
  @Max(30)
  chaptersPerModule: number;
}

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

  /**
   * Fase 3: repartir los contenidos del documento en esta forma (sin ella: la estructura del documento, como siempre).
   * Cada contenido queda en un solo capítulo y el curso guarda de dónde viene cada capítulo (cobertura verificable).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => StructureShapeDto)
  shape?: StructureShapeDto;

  /** Fase 2: la opción elegida en «¿Cómo quieres estructurar tu curso?» (personalizada = decisión de la institución). */
  @IsOptional()
  @IsIn(['document', 'cursia', 'format', 'custom'])
  choice?: 'document' | 'cursia' | 'format' | 'custom';
}

// LOOP 8.0: POST /courses/:courseId/modules/structure-origin — el editor avisa que terminó de aplicar la propuesta de la
// IA (con el contador resultante). Solo `ai_proposal`: el origen `academic_context` lo escribe únicamente el backend.
export class RecordStructureOriginDto {
  @IsInt()
  @Min(0)
  expectedCounter: number;

  @IsIn(['ai_proposal'])
  source: 'ai_proposal';

  /** Fase 2: la forma que se le pidió a la IA (Cursia recomienda, un formato o una personalizada). */
  @IsOptional()
  @IsIn(['cursia', 'format', 'custom'])
  choice?: 'cursia' | 'format' | 'custom';
}
