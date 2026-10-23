import { IsInt, Min } from 'class-validator';

// Body for POST /courses/:courseId/blueprints: the optimistic-concurrency
// counter the client is confirming (same shape/semantics as Fase 2's
// ExpectedCounterDto, kept as its own DTO — different resource/module).
export class CreateBlueprintDto {
  @IsInt()
  @Min(0)
  expectedCounter: number;
}
