import { IsString, IsOptional, MaxLength, MinLength } from 'class-validator';

export class TtsSpeechDto {
  /** Texto a sintetizar. Máximo 4000 chars por request. */
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text: string;

  /** Voz OpenAI: alloy, echo, fable, onyx, nova, shimmer, marin (default: marin) */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  voice?: string;

  /** Modelo OpenAI TTS (default: gpt-4o-mini-tts) */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  model?: string;

  /** Formato de salida: mp3 | opus | aac | flac (default: mp3) */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  format?: string;

  /**
   * Instrucciones opcionales de estilo de voz.
   * Ejemplo: "Habla con tono cálido y pausado, como si explicaras a un estudiante."
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  instructions?: string;
}
