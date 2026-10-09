import { PartialType, OmitType } from '@nestjs/mapped-types';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';
import { CreateChapterDto } from './create-chapter.dto';

export class UpdateChapterDto extends PartialType(
  OmitType(CreateChapterDto, ['expectedCounter'] as const),
) {
  @IsInt()
  @Min(0)
  expectedCounter: number;

  /**
   * LOOP 8.3: el docente cambió el video A MANO (editor): queda fijado y el diseño de Cursia lo respeta. Solo con
   * videoEnabled. Los cambios que hace Cursia (propuesta con IA, diseño) no lo envían.
   */
  @IsOptional()
  @IsBoolean()
  pinVideo?: boolean;

  /**
   * Review L84-4: el docente cambió la Actividad de Aplicación A MANO (editor V2): queda fijada y el diseño de Cursia la
   * respeta. Solo con applicationMinutes.
   */
  @IsOptional()
  @IsBoolean()
  pinApplication?: boolean;

  /** LOOP 9.2 (review C1): el docente cambió la actividad interactiva A MANO (editor V2): queda fijada. Solo con activityEnabled. */
  @IsOptional()
  @IsBoolean()
  pinActivity?: boolean;
}
