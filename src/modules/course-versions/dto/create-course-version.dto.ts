import {
  IsString,
  IsOptional,
  IsIn,
  IsObject,
  IsNumber,
  IsPositive,
  MaxLength,
} from 'class-validator';

export class CreateCourseVersionDto {
  @IsString()
  @IsOptional()
  @IsIn(['draft', 'ready', 'exported'])
  status?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsObject()
  @IsOptional()
  snapshotJson?: Record<string, any>;

  // ── Storage (Fase 5 — Drive unificado) ──────────────────────────
  /** Dónde está guardado el snapshot completo */
  @IsString()
  @IsOptional()
  @IsIn(['postgres_json', 'google_drive', 'external_url'])
  storageProvider?: string;

  /** ID del archivo en Google Drive */
  @IsString()
  @IsOptional()
  storageFileId?: string;

  /** URL del archivo (webViewLink de Drive) */
  @IsString()
  @IsOptional()
  storageFileUrl?: string;

  /** ID de la carpeta del curso en Drive */
  @IsString()
  @IsOptional()
  storageFolderId?: string;

  /** Ruta lógica dentro del storage */
  @IsString()
  @IsOptional()
  storagePath?: string;

  /** Estrategia del snapshot: 'full_json' | 'external_file' | 'hybrid' */
  @IsString()
  @IsOptional()
  @IsIn(['full_json', 'external_file', 'hybrid'])
  snapshotStrategy?: string;

  /** Tamaño del snapshot en bytes */
  @IsNumber()
  @IsPositive()
  @IsOptional()
  snapshotSizeBytes?: number;

  /** Tamaño legible ("2.4 MB") */
  @IsString()
  @IsOptional()
  @MaxLength(30)
  snapshotSizeHuman?: string;

  /** Manifiesto del snapshot */
  @IsObject()
  @IsOptional()
  manifestJson?: Record<string, any>;
}
