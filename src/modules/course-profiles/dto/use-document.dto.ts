import { ArrayMaxSize, IsArray, IsIn, IsOptional } from 'class-validator';
import { DERIVED_FIELDS } from '../../course-facts/course-facts';

// LOOP 8.1: POST /courses/:courseId/profiles/pedagogy/use-document — qué datos del perfil reemplazar con los del documento
// (ausente = todos los que el documento trae).
export class UseDocumentDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DERIVED_FIELDS.length)
  @IsIn(DERIVED_FIELDS as unknown as string[], { each: true })
  fields?: string[];
}
