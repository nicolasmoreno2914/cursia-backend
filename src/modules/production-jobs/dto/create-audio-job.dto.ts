import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAudioJobDto {
  @IsString()
  @MaxLength(120)
  courseId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  frontendJobId?: string | null;

  /** Datos del curso (D object desde el frontend). */
  @IsObject()
  courseData: Record<string, any>;

  /**
   * Extractos de los capítulos del libro guía para generar el guion del audiolibro.
   * Clave: "cap1"…"cap9" → primeros 600 chars del markdown del capítulo.
   */
  @IsOptional()
  @IsObject()
  bookExcerpts?: Record<string, string>;

  /** ID del artifact content_snapshot si ya existe, para que el worker lo registre. */
  @IsOptional()
  @IsString()
  contentSnapshotArtifactId?: string | null;

  @IsOptional()
  @IsObject()
  options?: {
    generateWelcomeAudio?: boolean;
    generateAudiobook?: boolean;
    audiobookOptional?: boolean;
    voice?: string;
    model?: string;
    maxCap?: number;
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
