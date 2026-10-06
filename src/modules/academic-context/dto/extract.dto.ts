import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBase64, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export class ExtractFileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  /** Contenido del archivo en base64 (≤ 7 MB decodificado; el límite total lo pone el body de 10 MB). */
  @IsBase64()
  dataBase64: string;
}

/** POST /courses/:courseId/academic-context/extract — 1 a 5 documentos (PDF con texto, DOCX, TXT, MD). */
export class ExtractAcademicContextDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ExtractFileDto)
  files: ExtractFileDto[];
}

/**
 * LOOP 8.1 · POST /courses/:courseId/academic-context/extract-advanced — lectura avanzada (solo PDF, 1 archivo).
 *   mode 'estimate' → páginas y costo estimado (no llama a ningún proveedor);
 *   mode 'run'      → transcribe con IA + extractor determinista; exige `acceptedMaxUsd` ≥ el máximo estimado
 *                     (el usuario vio y aceptó ese costo).
 */
export class ExtractAdvancedDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExtractFileDto)
  files: ExtractFileDto[];

  @IsIn(['estimate', 'run'])
  mode: 'estimate' | 'run';

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  acceptedMaxUsd?: number;
}
