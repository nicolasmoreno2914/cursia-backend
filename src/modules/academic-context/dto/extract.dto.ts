import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBase64, IsNotEmpty, IsString, MaxLength, ValidateNested } from 'class-validator';

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
