import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { PrebriefService } from './prebrief.service';

const SHA_RE = /^[0-9a-f]{64}$/;
const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});
function onlyKeys(b: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) throw new BadRequestException(`campos no permitidos: ${extra.join(', ')}`);
}
function sendPdf(res: Response, r: { pdf: Buffer; filename: string }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(r.pdf);
}

/** Prebrief pedagógico: propuesta versionada, aprobación y PDF. Todo pasa por el dueño del curso (SupabaseJwtGuard). */
@Controller('courses/:courseId')
@UseGuards(SupabaseJwtGuard)
export class PrebriefController {
  constructor(private readonly prebrief: PrebriefService) {}

  // GET /api/v1/courses/:courseId/prebrief → borrador vigente, preparación, versiones y estado.
  @Get('prebrief')
  state(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser) {
    return this.prebrief.state(courseId, user.id);
  }

  // GET …/prebrief/draft.pdf → PDF del borrador (marca de agua; no se guarda).
  @Get('prebrief/draft.pdf')
  async draftPdf(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Res() res: Response) {
    sendPdf(res, await this.prebrief.draftPdf(courseId, user.id));
  }

  // GET …/prebrief/events → historial (solo inserción).
  @Get('prebrief/events')
  events(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser) {
    return this.prebrief.events(courseId, user.id);
  }

  // POST …/prebrief/versions {expectedModelSha} → preparar para aprobación (201 nueva, 200 idempotente).
  @Post('prebrief/versions')
  async prepare(@Param('courseId', ParseIntPipe) courseId: number, @Body() body: unknown, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const b = obj(body);
    onlyKeys(b, ['expectedModelSha']);
    if (typeof b.expectedModelSha !== 'string' || !SHA_RE.test(b.expectedModelSha)) throw new BadRequestException('expectedModelSha es obligatorio (la huella de la propuesta que revisaste).');
    const r = await this.prebrief.prepare(courseId, user.id, { id: user.id, email: user.email }, b.expectedModelSha);
    res.status(r.created ? 201 : 200);
    return r;
  }

  @Get('prebrief/versions/:n')
  version(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @CurrentUser() user: AuthUser) {
    return this.prebrief.getVersion(courseId, user.id, n);
  }

  @Get('prebrief/versions/:n/diff')
  diff(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @CurrentUser() user: AuthUser) {
    return this.prebrief.diff(courseId, user.id, n);
  }

  // GET …/prebrief/versions/:n/pdf?variant=ready|approved|invalidated
  @Get('prebrief/versions/:n/pdf')
  async versionPdf(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @Query('variant') variant: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    sendPdf(res, await this.prebrief.versionPdf(courseId, user.id, n, typeof variant === 'string' ? variant : ''));
  }

  // POST …/prebrief/versions/:n/approve {expectedModelSha, name, role, confirm: true}
  @Post('prebrief/versions/:n/approve')
  @HttpCode(HttpStatus.OK)
  approve(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const b = obj(body);
    onlyKeys(b, ['expectedModelSha', 'name', 'role', 'confirm']);
    if (typeof b.expectedModelSha !== 'string' || !SHA_RE.test(b.expectedModelSha)) throw new BadRequestException('expectedModelSha es obligatorio (la huella de la versión que revisaste).');
    return this.prebrief.approve(courseId, user.id, { id: user.id, email: user.email }, n, { expectedModelSha: b.expectedModelSha, name: String(b.name ?? ''), role: String(b.role ?? ''), confirm: b.confirm === true });
  }

  // POST …/prebrief/versions/:n/request-changes {note}
  @Post('prebrief/versions/:n/request-changes')
  @HttpCode(HttpStatus.OK)
  requestChanges(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const b = obj(body);
    onlyKeys(b, ['note']);
    return this.prebrief.requestChanges(courseId, user.id, { id: user.id, email: user.email }, n, String(b.note ?? ''));
  }

  @Post('prebrief/versions/:n/withdraw')
  @HttpCode(HttpStatus.OK)
  withdraw(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @CurrentUser() user: AuthUser) {
    return this.prebrief.withdraw(courseId, user.id, { id: user.id }, n);
  }

  // PUT …/prebrief/exception-reasons {requirementKey, reason}
  @Put('prebrief/exception-reasons')
  exceptionReason(@Param('courseId', ParseIntPipe) courseId: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const b = obj(body);
    onlyKeys(b, ['requirementKey', 'reason']);
    if (typeof b.requirementKey !== 'string' || !b.requirementKey || b.requirementKey.length > 200) throw new BadRequestException('requirementKey es obligatorio.');
    return this.prebrief.setExceptionReason(courseId, user.id, { id: user.id, email: user.email }, b.requirementKey, String(b.reason ?? ''));
  }

  // POST …/prebrief/confirmations {confirmKey}
  @Post('prebrief/confirmations')
  @HttpCode(HttpStatus.OK)
  confirm(@Param('courseId', ParseIntPipe) courseId: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const b = obj(body);
    onlyKeys(b, ['confirmKey']);
    if (typeof b.confirmKey !== 'string' || !/^[0-9a-f]{32}$/.test(b.confirmKey)) throw new BadRequestException('confirmKey es obligatorio.');
    return this.prebrief.confirm(courseId, user.id, { id: user.id, email: user.email }, b.confirmKey);
  }

  // GET …/format → formato S/M/L elegido (o null) y el catálogo (para el selector de la interfaz).
  @Get('format')
  getFormat(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser) {
    return this.prebrief.getFormat(courseId, user.id);
  }

  // PUT …/format {code: 'S'|'M'|'L'|null}
  @Put('format')
  format(@Param('courseId', ParseIntPipe) courseId: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const b = obj(body);
    onlyKeys(b, ['code']);
    if (!('code' in b)) throw new BadRequestException('code es obligatorio (S, M, L o null).');
    return this.prebrief.setFormat(courseId, user.id, { id: user.id, email: user.email }, (b.code === null ? null : b.code) as any);
  }
}
