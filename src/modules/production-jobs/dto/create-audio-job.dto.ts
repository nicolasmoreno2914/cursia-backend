export class CreateAudioJobDto {
  courseId: string;
  frontendJobId?: string | null;

  /** Datos del curso (D object desde el frontend). */
  courseData: Record<string, any>;

  /**
   * Extractos de los capítulos del libro guía para generar el guion del audiolibro.
   * Clave: "cap1"…"cap9" → primeros 600 chars del markdown del capítulo.
   */
  bookExcerpts?: Record<string, string>;

  /** ID del artifact content_snapshot si ya existe, para que el worker lo registre. */
  contentSnapshotArtifactId?: string | null;

  options?: {
    generateWelcomeAudio?: boolean;
    generateAudiobook?: boolean;
    audiobookOptional?: boolean;
    voice?: string;
    model?: string;
    maxCap?: number;
  };

  metadata?: Record<string, any>;
}
