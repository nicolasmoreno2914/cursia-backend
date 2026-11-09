import { Type } from 'class-transformer';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { MBZ_READER_LIMITS } from '../mbz-reader';

/** r107 B1 · `POST /course-workshop/sessions`: nombre y tamaño del .mbz que el navegador va a subir (tope 300 MB). */
export class CreateWorkshopSessionDto {
  @IsString()
  @MaxLength(255)
  filename: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MBZ_READER_LIMITS.maxPackageBytes)
  sizeBytes: number;
}
