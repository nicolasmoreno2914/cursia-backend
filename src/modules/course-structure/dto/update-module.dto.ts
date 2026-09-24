import { PartialType, OmitType } from '@nestjs/mapped-types';
import { IsInt, Min } from 'class-validator';
import { CreateModuleDto } from './create-module.dto';

// expectedCounter siempre es requerido (nunca opcional, aunque el resto de
// los campos sí lo sea en un PATCH) — PartialType haría todo opcional
// incluido expectedCounter, así que se lo excluye y se lo vuelve a declarar.
export class UpdateModuleDto extends PartialType(
  OmitType(CreateModuleDto, ['expectedCounter'] as const),
) {
  @IsInt()
  @Min(0)
  expectedCounter: number;
}
