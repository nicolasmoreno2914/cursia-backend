import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { INSTITUTION_TYPES, MC_LIMITS, MODALITIES, REGEN_SECTIONS, TIME_MODES } from '../microcurriculum.types';

/**
 * r81 · DTOs del microcurrículo (límites de spec §1: textos ≤ 2 000, listas ≤ 40, horas 1–1 000). Todo es opcional:
 * el borrador se guarda paso a paso; las obligatorias (★) se exigen al generar (400 ANSWERS_INCOMPLETE). Un valor vacío
 * o null es «Que Cursia lo proponga».
 */

const TEXT = MC_LIMITS.text;
const LIST = MC_LIMITS.listItems;

export class IdentificationDto {
  @IsOptional() @IsString() @MaxLength(TEXT) courseName?: string;
  @IsOptional() @IsIn([...INSTITUTION_TYPES, '']) institutionType?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) program?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) term?: string;
  @IsOptional() @IsIn([...MODALITIES, '']) modality?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) code?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) area?: string;
}

export class LearnersDto {
  @IsOptional() @IsString() @MaxLength(TEXT) profile?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) priorKnowledge?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) context?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) specialNeeds?: string;
}

export class PurposeDto {
  @IsOptional() @IsString() @MaxLength(TEXT) need?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) expectedAbilities?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) competencies?: string;
}

export class SplitDto {
  @IsOptional() @IsNumber() @Min(0) @Max(MC_LIMITS.hoursMax) contact?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(MC_LIMITS.hoursMax) practice?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(MC_LIMITS.hoursMax) autonomous?: number;
}

export class TimeDto {
  @IsOptional() @IsIn([...TIME_MODES, '']) mode?: string;
  @IsOptional() @IsNumber() @Min(MC_LIMITS.hoursMin) @Max(MC_LIMITS.hoursMax) totalHours?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(60) credits?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(104) weeks?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(MC_LIMITS.hoursMax) hoursPerWeek?: number;
  @IsOptional() @ValidateNested() @Type(() => SplitDto) split?: SplitDto;
  @IsOptional() @IsString() @MaxLength(TEXT) calendar?: string;
}

export class ContentsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) @MaxLength(TEXT, { each: true }) requiredTopics?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) @MaxLength(TEXT, { each: true }) excludedTopics?: string[];
  @IsOptional() @IsInt() @Min(MC_LIMITS.unitCountMin) @Max(MC_LIMITS.unitCountMax) unitCount?: number;
}

export class MethodologyDto {
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) @MaxLength(TEXT, { each: true }) strategies?: string[];
  @IsOptional() @IsString() @MaxLength(TEXT) institutionalEvaluation?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) resources?: string;
}

export class ReferencesDto {
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) @MaxLength(TEXT, { each: true }) bibliography?: string[];
  @IsOptional() @IsString() @MaxLength(TEXT) author?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) notes?: string;
}

export class AnswersDto {
  @IsOptional() @ValidateNested() @Type(() => IdentificationDto) identification?: IdentificationDto;
  @IsOptional() @ValidateNested() @Type(() => LearnersDto) learners?: LearnersDto;
  @IsOptional() @ValidateNested() @Type(() => PurposeDto) purpose?: PurposeDto;
  @IsOptional() @ValidateNested() @Type(() => TimeDto) time?: TimeDto;
  @IsOptional() @ValidateNested() @Type(() => ContentsDto) contents?: ContentsDto;
  @IsOptional() @ValidateNested() @Type(() => MethodologyDto) methodology?: MethodologyDto;
  @IsOptional() @ValidateNested() @Type(() => ReferencesDto) references?: ReferencesDto;
}

/** POST /microcurricula — crea el borrador de respuestas. */
export class CreateMicrocurriculumDto {
  @IsOptional() @ValidateNested() @Type(() => AnswersDto) answers?: AnswersDto;
}

/** PATCH /microcurricula/:id — respuestas (cada paso enviado reemplaza ese paso) y/o documento editado en la revisión. */
export class UpdateMicrocurriculumDto {
  @IsOptional() @ValidateNested() @Type(() => AnswersDto) answers?: AnswersDto;
  /** MicrocurriculumV1 editado: se normaliza y se revalida en el servidor (V1–V8, USD 0). */
  @IsOptional() @IsObject() document?: Record<string, unknown>;
}

/** POST /microcurricula/:id/regenerate */
export class RegenerateSectionDto {
  @IsIn([...REGEN_SECTIONS]) section: string;
}
