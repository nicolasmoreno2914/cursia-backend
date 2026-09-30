import { IsUUID, IsInt, Max, Min } from 'class-validator';

export class MoveChapterDto {
  @IsUUID('4')
  targetModuleId: string;

  @IsInt()
  @Min(0)
  // Límite de int4: la posición se clampa en SQL (least($5::int, …)); un valor mayor daría 500.
  @Max(2147483647)
  targetPosition: number;

  @IsInt()
  @Min(0)
  expectedCounter: number;
}
