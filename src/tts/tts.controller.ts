import {
  Body,
  Controller,
  HttpStatus,
  Logger,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { DataSource } from 'typeorm';
import { SupabaseJwtGuard } from '../auth/supabase-jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { assertLegacyAudioAllowed } from '../modules/production-jobs/legacy-audio-guard';
import { TtsService } from './tts.service';
import { TtsSpeechDto } from './dto/tts-speech.dto';

/**
 * Proxy seguro para síntesis de voz con OpenAI TTS.
 * Prefijo global: /api/v1/tts
 *
 * Variables de entorno requeridas:
 *   OPENAI_API_KEY      → API key de OpenAI (en .env del servidor, nunca en frontend)
 *   OPENAI_TTS_MODEL    → Modelo (default: gpt-4o-mini-tts)
 *   OPENAI_TTS_VOICE    → Voz (default: marin)
 *
 * Endpoints:
 *   POST /api/v1/tts/speech  → devuelve audio/mpeg binario
 */
@Controller('tts')
@UseGuards(SupabaseJwtGuard)
export class TtsController {
  private readonly logger = new Logger(TtsController.name);

  constructor(
    private readonly ttsService: TtsService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Sintetiza texto a audio MP3.
   *
   * Body: TtsSpeechDto { text, voice?, model?, format?, instructions? }
   * Response: audio/mpeg binary
   *
   * Límite: 4000 chars por request.
   * Para textos largos, partir en chunks antes de llamar este endpoint.
   */
  @Post('speech')
  async speech(
    @Body() dto: TtsSpeechDto,
    @Res() res: Response,
    @CurrentUser() user?: AuthUser,
  ): Promise<void> {
    // Decisión del owner (V2): si el cliente declara el curso y es dynamic →
    // 409 `v2_course_legacy_audio_disabled:` ANTES de llamar a OpenAI (fuera
    // del try: lo responde el filtro global de excepciones).
    if (dto.courseId) {
      await assertLegacyAudioAllowed((sql, params) => this.dataSource.query(sql, params), user?.id ?? '', dto.courseId);
    }
    try {
      const result = await this.ttsService.synthesize({
        text:         dto.text,
        voice:        dto.voice,
        model:        dto.model,
        format:       dto.format || 'mp3',
        instructions: dto.instructions,
      });

      res.set({
        'Content-Type':   'audio/mpeg',
        'Content-Length': String(result.audioBuffer.length),
        'Cache-Control':  'no-store',
        'X-Tts-Voice':    result.voice,
        'X-Tts-Model':    result.model,
        'X-Tts-Chars':    String(result.chars),
      });

      res.status(HttpStatus.OK).send(result.audioBuffer);

    } catch (e) {
      const msg = (e as Error).message ?? 'Error desconocido';
      this.logger.error(`[TTS] speech error: ${msg}`);

      if (res.headersSent) return;

      const status = msg.includes('OPENAI_API_KEY')
        ? HttpStatus.SERVICE_UNAVAILABLE
        : msg.includes('límite') || msg.includes('vacío')
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.BAD_GATEWAY;

      res.status(status).json({ error: msg });
    }
  }
}
