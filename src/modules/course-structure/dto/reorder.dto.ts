import { IsArray, IsUUID, IsInt, Min, ArrayMinSize } from 'class-validator';

export class ReorderDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  order: string[];

  @IsInt()
  @Min(0)
  expectedCounter: number;
}
