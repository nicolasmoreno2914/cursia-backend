import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { from, Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { rbacMode } from './authz-flags';
import { readRef } from './permission.guard';
import { AUTHZ_REQUIRE_PERMISSION_KEY, PermissionRequirement } from './require-permission.decorator';
import { columnExists, numericCourseId } from './schema-probe';

/**
 * r75 B2 (02 §E.3): «todos los POST/PUT/PATCH/DELETE de estructura, perfiles, diseño, contexto académico, facts y
 * blueprints → P(courses.edit). Actualizan `updated_by`». En vez de tocar cada servicio: después de una respuesta
 * EXITOSA de un handler `@RequirePermission('courses.edit', { course })`, `courses.updated_by = actor` (si la columna de
 * A existe). Solo con `CURSIA_RBAC_MODE≠off` (off = cero cambios). Nunca falla la respuesta.
 */
@Injectable()
export class CourseAuthorshipInterceptor implements NestInterceptor {
  private readonly logger = new Logger('CourseAuthorship');

  constructor(private readonly reflector: Reflector, @Optional() private readonly dataSource?: DataSource) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const r = this.reflector.get<PermissionRequirement | undefined>(AUTHZ_REQUIRE_PERMISSION_KEY, context.getHandler());
    if (!r || r.permission !== 'courses.edit' || !('course' in r.scope) || rbacMode() === 'off' || !this.dataSource) return next.handle();
    const req = context.switchToHttp().getRequest();
    const courseId = numericCourseId(readRef(req, (r.scope as { course: any }).course));
    const actor = req?.user?.id;
    return next.handle().pipe(
      mergeMap((value) => from(this.stamp(courseId, actor).then(() => value))),
    );
  }

  private async stamp(courseId: number | null, actor: string | undefined): Promise<void> {
    if (!courseId || !actor) return;
    try {
      const q = (sql: string, p?: unknown[]) => this.dataSource!.query(sql, p as any[]);
      if (!(await columnExists(q, 'courses', 'updated_by'))) return;
      await q(`update public.courses set updated_by = $2 where id = $1`, [courseId, actor]);
    } catch (err) {
      this.logger.warn(`updated_by no registrado en el curso ${courseId}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
  }
}
