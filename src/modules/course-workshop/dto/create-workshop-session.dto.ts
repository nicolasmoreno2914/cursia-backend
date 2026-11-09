import { Type } from 'class-transformer';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { WORKSHOP_MAX_UPLOAD_BYTES } from '../workshop-limits';

/** r107 B1 · `POST /course-workshop/sessions`: nombre y tamaño del .mbz que el navegador va a subir (tope 200 MB: WORKSHOP_MAX_UPLOAD_BYTES). */
export class CreateWorkshopSessionDto {
  @IsString()
  @MaxLength(255)
  filename: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(WORKSHOP_MAX_UPLOAD_BYTES)
  sizeBytes: number;
}
