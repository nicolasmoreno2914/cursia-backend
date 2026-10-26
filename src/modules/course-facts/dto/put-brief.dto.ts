import { IsArray, IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

// LOOP 8.1: PUT /courses/:courseId/brief — lo que el usuario dijo del curso (pantalla Datos). Mismos nombres que el
// contexto que se congela al generar.
// r73 UX-10: ya NO reemplaza el pedido completo. Es un parche por campo (ver mergeBrief en course-facts.ts):
//   - formato nuevo: { baseRevision, set: { campo: texto }, clear: [campo…], inferred: { add, remove } };
//   - formato anterior (campos sueltos): un campo vacío o ausente = «no mandado» (nunca borra); solo `clear` borra.
// Los campos de `set`/`clear`/`inferred` se validan en briefPatchFromBody (dato conocido, texto, máximo).
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
  /** r73 UX-10: revisión del pedido que el cliente leyó (concurrencia por campo: gana lo más nuevo del servidor). */
  @IsOptional() @IsInt() @Min(0) baseRevision?: number;
  /** r73 UX-10: SOLO los datos que el usuario cambió desde que leyó el pedido. */
  @IsOptional() @IsObject() set?: Record<string, string>;
  /** r73 UX-10: datos que el usuario borró a propósito (única forma de borrar). */
  @IsOptional() @IsArray() @IsString({ each: true }) clear?: string[];
  /** r73 UX-10: marca «inferido» por dato ({ add: [...], remove: [...] }). */
  @IsOptional() @IsObject() inferred?: { add?: string[]; remove?: string[] };
}
