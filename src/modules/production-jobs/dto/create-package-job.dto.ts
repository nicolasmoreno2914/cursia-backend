export class CreatePackageJobDto {
  courseId: string;
  frontendJobId?: string | null;

  /** UUID del content_snapshot artifact (para que el worker descargue D y F). */
  contentSnapshotArtifactId: string;

  /** UUID del h5p_snapshot artifact (para que el worker descargue MEDIA_HVP). */
  h5pSnapshotArtifactId?: string | null;

  /** UUID del audio_welcome artifact. */
  audioWelcomeArtifactId?: string | null;

  /** UUID del audiobook artifact. */
  audiobookArtifactId?: string | null;

  options?: {
    moodleVersion?: string;
    validatePackage?: boolean;
  };

  metadata?: Record<string, any>;
}
