import { IsUUID, IsInt, Min } from 'class-validator';

export class MoveChapterDto {
  @IsUUID('4')
  targetModuleId: string;

  @IsInt()
  @Min(0)
  targetPosition: number;

  @IsInt()
  @Min(0)
  expectedCounter: number;
}
