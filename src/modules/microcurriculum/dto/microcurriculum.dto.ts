import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { INSTITUTION_OTHER_MAX, INSTITUTION_TYPES, MC_LIMITS, MODALITIES, REGEN_SECTIONS, STRATEGIES, TIME_MODES } from '../microcurriculum.types';

/**
 * r81 · DTOs del microcurrículo (límites de spec §1: textos ≤ 2 000, listas ≤ 40, horas 1–1 000). Todo es opcional:
 * el borrador se guarda paso a paso; las obligatorias (★) se exigen al generar (400 ANSWERS_INCOMPLETE). Un valor vacío
 * o null es «Que Cursia lo proponga».
 */

const TEXT = MC_LIMITS.text;

/**
 * Números opcionales: '' (campo vacío) o null → «Que Cursia lo proponga» (undefined), NUNCA 0 — la conversión
 * implícita convertía '' en 0 y un reparto vacío se volvía la restricción dura «0 h» (review P2-6). Un texto numérico
 * («120», «2,5») se convierte; cualquier otro texto llega tal cual y lo rechaza @IsNumber.
 */
const OptNum = () => Transform(({ obj, key }) => {
  const v = obj[key];
  if (v === '' || v === null || v === undefined) return undefined;
  if (typeof v === 'string' && /^\s*-?\d+([.,]\d+)?\s*$/.test(v)) return Number(v.replace(',', '.'));
  return v;
});
const LIST = MC_LIMITS.listItems;

export class IdentificationDto {
  @IsOptional() @IsString() @MaxLength(TEXT) courseName?: string;
  @IsOptional() @IsIn([...INSTITUTION_TYPES, '']) institutionType?: string;
  /** r101 · «¿Cuál?» del tipo `otro` (obligatorio al generar si el tipo es `otro`; lo exige missingRequired). */
  @IsOptional() @IsString() @MaxLength(INSTITUTION_OTHER_MAX) institutionTypeOther?: string;
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
  @IsOptional() @OptNum() @IsNumber() @Min(0) @Max(MC_LIMITS.hoursMax) contact?: number;
  @IsOptional() @OptNum() @IsNumber() @Min(0) @Max(MC_LIMITS.hoursMax) practice?: number;
  @IsOptional() @OptNum() @IsNumber() @Min(0) @Max(MC_LIMITS.hoursMax) autonomous?: number;
}

export class TimeDto {
  @IsOptional() @IsIn([...TIME_MODES, '']) mode?: string;
  @IsOptional() @OptNum() @IsNumber() @Min(MC_LIMITS.hoursMin) @Max(MC_LIMITS.hoursMax) totalHours?: number;
  @IsOptional() @OptNum() @IsNumber() @Min(0.5) @Max(60) credits?: number;
  @IsOptional() @OptNum() @IsNumber() @Min(1) @Max(104) weeks?: number;
  @IsOptional() @OptNum() @IsNumber() @Min(0.5) @Max(MC_LIMITS.hoursMax) hoursPerWeek?: number;
  @IsOptional() @ValidateNested() @Type(() => SplitDto) split?: SplitDto;
  @IsOptional() @IsString() @MaxLength(TEXT) calendar?: string;
}

export class ContentsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) @MaxLength(TEXT, { each: true }) requiredTopics?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) @MaxLength(TEXT, { each: true }) excludedTopics?: string[];
  @IsOptional() @OptNum() @IsInt() @Min(MC_LIMITS.unitCountMin) @Max(MC_LIMITS.unitCountMax) unitCount?: number;
}

export class MethodologyDto {
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @IsIn([...STRATEGIES], { each: true }) strategies?: string[];
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

/** PATCH /microcurricula/:id — respuestas COMPLETAS (reemplazan las guardadas) y/o documento editado en la revisión. */
export class UpdateMicrocurriculumDto {
  @IsOptional() @ValidateNested() @Type(() => AnswersDto) answers?: AnswersDto;
  /** MicrocurriculumV1 editado: se normaliza y se revalida en el servidor (V1–V8, USD 0). */
  @IsOptional() @IsObject() document?: Record<string, unknown>;
}

/** POST /microcurricula/:id/regenerate */
export class RegenerateSectionDto {
  @IsIn([...REGEN_SECTIONS]) section: string;
}
