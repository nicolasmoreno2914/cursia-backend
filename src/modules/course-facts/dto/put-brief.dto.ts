import { IsOptional, IsString, MaxLength } from 'class-validator';

// LOOP 8.1: PUT /courses/:courseId/brief — lo que el usuario dijo del curso (pantalla Datos). Mismos nombres que el
// contexto que se congela al generar. Reemplaza el pedido completo (un campo ausente o vacío = sin valor).
export class PutBriefDto {
  @IsOptional() @IsString() @MaxLength(255) nombre?: string;
  @IsOptional() @IsString() @MaxLength(600) obj?: string;
  @IsOptional() @IsString() @MaxLength(255) sector?: string;
  @IsOptional() @IsString() @MaxLength(100) pais?: string;
  @IsOptional() @IsString() @MaxLength(100) ciudad?: string;
  @IsOptional() @IsString() @MaxLength(400) contexto?: string;
  @IsOptional() @IsString() @MaxLength(255) nivel?: string;
  @IsOptional() @IsString() @MaxLength(255) tono?: string;
  @IsOptional() @IsString() @MaxLength(255) comp?: string;
}
