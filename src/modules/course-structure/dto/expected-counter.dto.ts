import { IsInt, Min } from 'class-validator';

// Body for DELETE endpoints: only the optimistic-concurrency counter.
export class ExpectedCounterDto {
  @IsInt()
  @Min(0)
  expectedCounter: number;
}
