import { IsString, IsNotEmpty, IsOptional, MaxLength, IsBoolean, IsInt, Min } from 'class-validator';

export class CreateModuleDto {
  // Title Normalization: se aceptan hasta 1000 caracteres para poder SEPARAR un título pegado con su
  // descripción; el servicio guarda un título ≤ 80 (o responde CHAPTER/MODULE_TITLE_TOO_LONG).
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  title: string;

  @IsString()
  @IsOptional()
  objective?: string;

  /** Detalle/alcance del módulo o capítulo (lo que antes se metía en el título). */
  @IsString()
  @IsOptional()
  @MaxLength(2000) // = STRUCTURE_DESCRIPTION_MAX (una separación automática puede dejarla > 1000)
  description?: string;

  @IsBoolean()
  @IsOptional()
  examEnabled?: boolean;

  @IsInt()
  @Min(0)
  expectedCounter: number;
}
