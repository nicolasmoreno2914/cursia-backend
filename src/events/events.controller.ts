/* ══════════════════════════════════════════════════════════════
   events.controller.ts — POST /api/v1/events
   ══════════════════════════════════════════════════════════════

   Endpoint fire-and-forget para el frontend.
   Siempre responde 200 aunque el guardado falle internamente.
   El frontend NUNCA debe bloquear la generación esperando este endpoint.
   ══════════════════════════════════════════════════════════════ */

import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { SupabaseJwtGuard } from '../auth/supabase-jwt.guard';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { AuthUser } from '../auth/auth.types';

@Controller('events')
@UseGuards(SupabaseJwtGuard)
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  /**
   * POST /api/v1/events
   *
   * Registra un evento de uso. Fire-and-forget: responde siempre 200.
   * El user_id se extrae del JWT, nunca del body.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async createEvent(
    @Body() body: CreateEventDto,
    @Req() req: Request,
  ) {
    if (!body || !body.event_type) {
      throw new BadRequestException('event_type es requerido');
    }

    const user = (req as any).user as AuthUser;
    const result = await this.eventsService.create(body, user);

    return {
      ok: result.ok,
      ...(result.id ? { id: result.id } : {}),
    };
  }
}
