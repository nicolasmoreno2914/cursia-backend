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
  /** LOOP 8.2: claves que llenó Cursia (no el usuario), separadas por comas: «Lo que entendimos» las muestra como inferidas. */
  @IsOptional() @IsString() @MaxLength(100) inferidos?: string;
  /** Review L81 M1: el `updatedAt` del pedido que vio el cliente; si otro guardado lo cambió → 409 BRIEF_CHANGED. */
  @IsOptional() @IsString() @MaxLength(40) expectedUpdatedAt?: string;
}
