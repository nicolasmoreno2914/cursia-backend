import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseJwtGuard } from '../../auth/supabase-jwt.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser } from '../../auth/auth.types';
import { PrebriefService } from './prebrief.service';
import { Access } from '../authz/access.decorator';
import type { AccessContext } from '../authz/access-context';
import { RequirePermission } from '../authz/require-permission.decorator';
import { ForbiddenException } from '@nestjs/common';

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

/**
 * Prebrief pedagógico: propuesta versionada, aprobación y PDF. r75: con RBAC en enforce actúa cualquier miembro con el
 * permiso (02 §E.2) sobre el curso (effectiveOwnerId = dueño técnico); el ACTOR (quién aprueba / pide ajustes) es
 * siempre el usuario de la sesión (`{ id: user.id }`).
 */
@Controller('courses/:courseId')
@UseGuards(SupabaseJwtGuard)
export class PrebriefController {
  constructor(private readonly prebrief: PrebriefService) {}

  // GET /api/v1/courses/:courseId/prebrief → borrador vigente, preparación, versiones y estado.
  @Get('prebrief')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  state(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.prebrief.state(courseId, access.effectiveOwnerId);
  }

  // GET …/prebrief/draft.pdf → PDF del borrador (marca de agua; no se guarda).
  @Get('prebrief/draft.pdf')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  async draftPdf(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext, @Res() res: Response) {
    sendPdf(res, await this.prebrief.draftPdf(courseId, access.effectiveOwnerId));
  }

  // GET …/prebrief/events → historial (solo inserción).
  @Get('prebrief/events')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  events(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.prebrief.events(courseId, access.effectiveOwnerId);
  }

  // POST …/prebrief/versions {expectedModelSha} → preparar para aprobación (201 nueva, 200 idempotente).
  @Post('prebrief/versions')
  @RequirePermission('proposals.review', { course: 'param:courseId' })
  async prepare(@Param('courseId', ParseIntPipe) courseId: number, @Body() body: unknown, @CurrentUser() user: AuthUser, @Access() access: AccessContext, @Res({ passthrough: true }) res: Response) {
    const b = obj(body);
    onlyKeys(b, ['expectedModelSha']);
    if (typeof b.expectedModelSha !== 'string' || !SHA_RE.test(b.expectedModelSha)) throw new BadRequestException('expectedModelSha es obligatorio (la huella de la propuesta que revisaste).');
    const r = await this.prebrief.prepare(courseId, access.effectiveOwnerId, { id: user.id, email: user.email }, b.expectedModelSha);
    res.status(r.created ? 201 : 200);
    return r;
  }

  @Get('prebrief/versions/:n')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  version(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.prebrief.getVersion(courseId, access.effectiveOwnerId, n);
  }

  @Get('prebrief/versions/:n/diff')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  diff(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.prebrief.diff(courseId, access.effectiveOwnerId, n);
  }

  // GET …/prebrief/versions/:n/pdf?variant=ready|approved|invalidated
  @Get('prebrief/versions/:n/pdf')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  async versionPdf(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @Query('variant') variant: string, @CurrentUser() user: AuthUser, @Access() access: AccessContext, @Res() res: Response) {
    // r75 (02 §E.2): el PDF APROBADO es un entregable → exports.download (RBAC enforce; el SA siempre). R75-E16: se decide
    // en el servicio sobre la variante RESUELTA (sin ?variant una versión aprobada también es el aprobado).
    const canDownloadApproved = access.legacy || access.superAdmin || access.permissions.has('exports.download');
    sendPdf(res, await this.prebrief.versionPdf(courseId, access.effectiveOwnerId, n, typeof variant === 'string' ? variant : '', canDownloadApproved));
  }

  // POST …/prebrief/versions/:n/approve {expectedModelSha, name, role, confirm: true}
  @Post('prebrief/versions/:n/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('proposals.approve', { course: 'param:courseId' })
  approve(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @Body() body: unknown, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    const b = obj(body);
    onlyKeys(b, ['expectedModelSha', 'name', 'role', 'confirm']);
    if (typeof b.expectedModelSha !== 'string' || !SHA_RE.test(b.expectedModelSha)) throw new BadRequestException('expectedModelSha es obligatorio (la huella de la versión que revisaste).');
    return this.prebrief.approve(courseId, access.effectiveOwnerId, { id: user.id, email: user.email }, n, { expectedModelSha: b.expectedModelSha, name: String(b.name ?? ''), role: String(b.role ?? ''), confirm: b.confirm === true });
  }

  // POST …/prebrief/versions/:n/request-changes {note}
  @Post('prebrief/versions/:n/request-changes')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('proposals.review', { course: 'param:courseId' })
  requestChanges(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @Body() body: unknown, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    const b = obj(body);
    onlyKeys(b, ['note']);
    return this.prebrief.requestChanges(courseId, access.effectiveOwnerId, { id: user.id, email: user.email }, n, String(b.note ?? ''));
  }

  @Post('prebrief/versions/:n/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('proposals.review', { course: 'param:courseId' })
  withdraw(@Param('courseId', ParseIntPipe) courseId: number, @Param('n', ParseIntPipe) n: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.prebrief.withdraw(courseId, access.effectiveOwnerId, { id: user.id }, n);
  }

  // PUT …/prebrief/exception-reasons {requirementKey, reason}
  @Put('prebrief/exception-reasons')
  @RequirePermission('proposals.review', { course: 'param:courseId' })
  exceptionReason(@Param('courseId', ParseIntPipe) courseId: number, @Body() body: unknown, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    const b = obj(body);
    onlyKeys(b, ['requirementKey', 'reason']);
    if (typeof b.requirementKey !== 'string' || !b.requirementKey || b.requirementKey.length > 200) throw new BadRequestException('requirementKey es obligatorio.');
    return this.prebrief.setExceptionReason(courseId, access.effectiveOwnerId, { id: user.id, email: user.email }, b.requirementKey, String(b.reason ?? ''));
  }

  // POST …/prebrief/confirmations {confirmKey}
  @Post('prebrief/confirmations')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('proposals.review', { course: 'param:courseId' })
  confirm(@Param('courseId', ParseIntPipe) courseId: number, @Body() body: unknown, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    const b = obj(body);
    onlyKeys(b, ['confirmKey']);
    if (typeof b.confirmKey !== 'string' || !/^[0-9a-f]{32}$/.test(b.confirmKey)) throw new BadRequestException('confirmKey es obligatorio.');
    return this.prebrief.confirm(courseId, access.effectiveOwnerId, { id: user.id, email: user.email }, b.confirmKey);
  }

  // GET …/format → formato S/M/L elegido (o null) y el catálogo (para el selector de la interfaz).
  @Get('format')
  @RequirePermission('courses.view', { course: 'param:courseId' })
  getFormat(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    return this.prebrief.getFormat(courseId, access.effectiveOwnerId);
  }

  // PUT …/format {code: 'S'|'M'|'L'|null}
  @Put('format')
  @RequirePermission('courses.edit', { course: 'param:courseId' })
  format(@Param('courseId', ParseIntPipe) courseId: number, @Body() body: unknown, @CurrentUser() user: AuthUser, @Access() access: AccessContext) {
    const b = obj(body);
    onlyKeys(b, ['code']);
    if (!('code' in b)) throw new BadRequestException('code es obligatorio (S, M, L o null).');
    return this.prebrief.setFormat(courseId, access.effectiveOwnerId, { id: user.id, email: user.email }, (b.code === null ? null : b.code) as any);
  }
}
