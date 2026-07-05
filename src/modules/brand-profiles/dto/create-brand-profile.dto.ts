import {
  IsString,
  IsOptional,
  IsObject,
  Matches,
  IsNotEmpty,
} from 'class-validator';

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Fase 1: carga manual del brand kit (sin extracción por IA).
 * Los 8 campos de color siguen la misma forma que PALETTES[] del frontend.
 */
export class CreateBrandProfileDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @Matches(HEX) m1: string;
  @Matches(HEX) m1a: string;
  @Matches(HEX) m2: string;
  @Matches(HEX) m2a: string;
  @Matches(HEX) m3: string;
  @Matches(HEX) m3a: string;
  @Matches(HEX) accent: string;
  @Matches(HEX) dark: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  logoArtifactId?: string;

  @IsOptional()
  @IsObject()
  typography?: Record<string, any>;

  @IsOptional()
  @IsObject()
  usageRules?: Record<string, any>;
}
