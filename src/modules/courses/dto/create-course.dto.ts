import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  IsIn,
  IsObject,
} from 'class-validator';

export class CreateCourseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  /** Sector / área temática del curso */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  sector?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  level?: string;

  @IsString()
  @IsOptional()
  @IsIn(['draft', 'in_review', 'published', 'archived'])
  status?: string;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;

  // ── Storage (Fase 5 — Drive unificado) ──────────────────────────
  @IsString()
  @IsOptional()
  @IsIn(['google_drive', 'postgres_json', 'external_url'])
  storageProvider?: string;

  @IsString()
  @IsOptional()
  storageFolderId?: string;

  @IsString()
  @IsOptional()
  storageFolderUrl?: string;
}
