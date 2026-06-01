import { IsOptional, IsString, IsObject } from 'class-validator';

export class CreateJobDto {
  /**
   * ID del curso. Puede ser:
   *   - string UUID del frontend (ACTIVE_COURSE_ID)
   *   - string numérico del backend courses.id
   * Se guarda en frontend_course_id como texto. Si es numérico,
   * también se asigna a course_id (FK).
   */
  @IsOptional()
  @IsString()
  course_id?: string;

  /** ID del job en el frontend (CP.jobId = 'prod_1717000000'). */
  @IsOptional()
  @IsString()
  frontend_job_id?: string;

  /** Opciones del pipeline: generateVideos, maxVideoChapters, etc. */
  @IsOptional()
  @IsObject()
  options?: Record<string, any>;
}
