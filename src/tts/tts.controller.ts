import {
  Body,
  Controller,
  HttpStatus,
  Logger,
  Optional,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Response } from 'express';
import { DataSource } from 'typeorm';
import { SupabaseJwtGuard } from '../auth/supabase-jwt.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { assertLegacyAudioAllowed } from '../modules/production-jobs/legacy-audio-guard';
import { TtsService } from './tts.service';
import { TtsSpeechDto } from './dto/tts-speech.dto';
import { FinopsLedgerService } from '../modules/finops/finops-ledger.service';
import { assertDirectCallAllowed, recordDirectTtsCall } from '../modules/finops/direct-call-ledger';
import { mp3DurationSeconds } from '../package/audio/mp3-parser';
import { AuthenticatedOnly } from '../modules/authz/require-permission.decorator';

/**
 * Proxy seguro para síntesis de voz con OpenAI TTS.
 * Prefijo global: /api/v1/tts
 *
 * Variables de entorno requeridas:
 *   OPENAI_API_KEY      → API key de OpenAI (en .env del servidor, nunca en frontend)
 *   OPENAI_TTS_MODEL    → Modelo (default: gpt-4o-mini-tts-2025-03-20; el alias se normaliza salvo OPENAI_TTS_ALLOW_ALIAS=true)
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
    @Optional() private readonly ledger?: FinopsLedgerService,
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
  @AuthenticatedOnly("TTS directo del usuario (atribución del curso verificada en el ledger)")
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
    // r58: kill switch / allow-list de proveedores ANTES de llamar a OpenAI (esta ruta no reserva).
    assertDirectCallAllowed('openai');
    try {
      const result = await this.ttsService.synthesize({
        text:         dto.text,
        voice:        dto.voice,
        model:        dto.model,
        format:       dto.format || 'mp3',
        instructions: dto.instructions,
      });

      // FinOps P0 (audit §4 #8): esta ruta (legacy v1) llamaba a OpenAI con la clave de Cursia sin pasar por el ledger.
      // Ahora el cargo queda registrado con los segundos MEDIDOS del MP3 (sin medición → pendiente, nunca un monto
      // inventado), atribuido al curso si el id es numérico y del mismo dueño; si no, sin atribuir con motivo.
      let audioSeconds: number | null = null;
      if ((dto.format || 'mp3') === 'mp3') {
        try { audioSeconds = mp3DurationSeconds(result.audioBuffer); } catch { audioSeconds = null; }
      }
      const numericCourse = typeof dto.courseId === 'string' && /^\d{1,9}$/.test(dto.courseId.trim()) ? Number(dto.courseId.trim()) : null;
      await recordDirectTtsCall(this.ledger, this.logger, {
        ownerId: user?.id ?? null, model: result.model, requestId: result.requestId ?? null, audioSeconds, characters: result.chars,
        courseId: numericCourse, unattributedReason: dto.courseId ? 'legacy_tts_course_not_numeric' : 'legacy_tts_no_course',
        recordedBy: 'tts-speech', localCallId: randomUUID(),
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
