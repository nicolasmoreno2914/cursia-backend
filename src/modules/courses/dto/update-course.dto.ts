import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateCourseDto } from './create-course.dto';

// structureVersion se omite a propósito: un curso legacy nunca debe poder
// convertirse en dynamic (ni viceversa) vía PATCH /courses/:id. Con el
// ValidationPipe global (whitelist + forbidNonWhitelisted), enviar
// structureVersion en un PATCH ahora es rechazado con 400.
export class UpdateCourseDto extends PartialType(
  OmitType(CreateCourseDto, ['structureVersion'] as const),
) {}
