export class CreateFullCourseJobDto {
  courseId: string;
  courseData?: Record<string, any>;
  options?: {
    generateContent?: boolean;
    generateAudio?: boolean;
    generateVideos?: boolean;
    uploadToYoutube?: boolean;
    generatePackage?: boolean;
    audiobookOptional?: boolean;
    maxVideoChapters?: number;
  };
  frontendJobId?: string;
  metadata?: Record<string, any>;
}
