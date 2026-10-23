import { IsBoolean, IsIn, IsInt, IsOptional, Min } from 'class-validator';

/**
 * V2.1 (R3): toggles de producto a nivel curso que entran en el Blueprint v2
 * (cambian el conjunto de items del Manifest). Misma concurrencia optimista
 * que el resto de las mutaciones de estructura: `expectedCounter` requerido.
 */
export class UpdateStructureSettingsDto {
  @IsBoolean()
  @IsOptional()
  finalExam?: boolean;

  @IsIn(['h5p', 'scorm'])
  @IsOptional()
  activityEngine?: 'h5p' | 'scorm';

  /** EV6 H5P v2: «Repaso» con Dialog Cards (courses.review_cards_enabled). */
  @IsBoolean()
  @IsOptional()
  reviewCardsEnabled?: boolean;

  @IsInt()
  @Min(0)
  expectedCounter: number;
}
