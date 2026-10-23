import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBase64, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';

export class ExtractFileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  /** Contenido del archivo en base64 (≤ 25 MB decodificado; el cuerpo de /extract admite 36 MB, ver main.ts). */
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

/**
 * LOOP 8.2 · POST /courses/:courseId/academic-context/proposal — lo que Cursia entendió del pedido SIN documento
 * (interpretado en el cliente con una consulta pequeña de IA). Se guarda como contexto `inferred`, nunca encima de
 * un contexto que viene de un documento.
 */
export class ProposalDto {
  @IsInt()
  @Min(0)
  expectedVersion: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subjectName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  generalObjective?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  learnerProfile?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(600, { each: true })
  priorKnowledge?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(400, { each: true })
  outcomes: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(400, { each: true })
  competencies?: string[];
}

export class OutcomeEditDto {
  @IsOptional()
  @Matches(/^RA[0-9]{1,3}$/)
  id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  text: string;
}

/**
 * LOOP 8.2 · PUT /courses/:courseId/academic-context/outcomes — el docente corrige los resultados («Editar» en «Lo que
 * entendimos») o confirma los propuestos (`accept`). Lo que no cambió conserva su origen; lo editado queda «escrito por ti».
 */
export class OutcomesDto {
  @IsInt()
  @Min(0)
  expectedVersion: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => OutcomeEditDto)
  outcomes: OutcomeEditDto[];

  @IsOptional()
  @IsBoolean()
  accept?: boolean;
}

/** LOOP 8.6B · PUT /courses/:courseId/academic-context/requirements/selection — alternativa elegida (o null para quitarla). */
export class RequirementSelectionDto {
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,40}$/)
  groupId: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,8}$/)
  optionId?: string | null;
}
