import { PartialType, OmitType } from '@nestjs/mapped-types';
import { IsInt, Min } from 'class-validator';
import { CreateChapterDto } from './create-chapter.dto';

export class UpdateChapterDto extends PartialType(
  OmitType(CreateChapterDto, ['expectedCounter'] as const),
) {
  @IsInt()
  @Min(0)
  expectedCounter: number;
}
