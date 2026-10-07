import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CourseDesignService } from './course-design.service';

/**
 * R68 · Bloqueo REAL de generación en el servidor (piloto, 2026-10-07).
 *
 * La interfaz V2 solo deja generar un diseño verificado, aplicable, sin cambios pendientes y sin críticos; este gate
 * aplica la MISMA regla en el servidor para toda generación nueva (API directa, frontend antiguo, navegador manipulado,
 * editor «Avanzado», regeneración `fromRun`, reapertura de un run cancelado/fallido):
 *   1. el Blueprint a generar es el vigente del curso y congeló la estructura viva (nada cambió desde que se aprobó);
 *   2. «Cursia recomienda» sobre esa estructura (mismo cálculo que ve el docente, solo lectura, USD 0) da un diseño
 *      aplicable, verificado, SIN críticos y sin cambios por aplicar.
 * Si algo no se cumple → 409 `GENERATION_NOT_VERIFIED` con el motivo y la lista de críticos. Nunca se crea nada.
 * Retomar una generación ya en curso no pasa por aquí (no es una generación nueva).
 */
export const GENERATION_NOT_VERIFIED = 'GENERATION_NOT_VERIFIED';

export type GenerationGateReason = 'blueprint_missing' | 'blueprint_not_current' | 'structure_changed' | 'unverified' | 'not_applicable' | 'pending_changes' | 'critical';

const MESSAGES: Record<GenerationGateReason, string> = {
  blueprint_missing: 'el curso no tiene una estructura aprobada para generar.',
  blueprint_not_current: 'la estructura aprobada que se quiere generar no es la vigente del curso.',
  structure_changed: 'la estructura cambió después de aprobarla; vuelve a revisarla y aprobarla en «Revisar y generar».',
  unverified: 'no se pudo verificar el diseño del curso.',
  not_applicable: 'el diseño del curso no se puede preparar para generar (revísalo en «Diseño»).',
  pending_changes: 'la estructura no tiene el diseño verificado: hay cambios recomendados sin aplicar (revísalo en «Diseño»).',
  critical: 'Verificación tiene problemas críticos sin resolver.',
};

export interface GenerationGateResult {
  ok: true;
  structureCounter: number;
  blueprintId: number;
}

@Injectable()
export class GenerationDesignGate {
  constructor(
    private readonly dataSource: DataSource,
    private readonly design: CourseDesignService,
  ) {}

  private reject(reason: GenerationGateReason, extra: Record<string, unknown> = {}): never {
    throw new ConflictException({ code: GENERATION_NOT_VERIFIED, reason, message: `${GENERATION_NOT_VERIFIED}: ${MESSAGES[reason]} No se generó nada.`, ...extra });
  }

  async assertVerified(courseId: number, ownerId: string, blueprintNumber: number): Promise<GenerationGateResult> {
    const [course] = await this.dataSource.query(
      `select id, structure_version_counter, current_blueprint_id from public.courses where id = $1 and owner_id = $2`,
      [courseId, ownerId],
    );
    if (!course) this.reject('blueprint_missing');
    const [bp] = await this.dataSource.query(
      `select id, structure_counter_at_lock from public.course_blueprints where course_id = $1 and blueprint_number = $2`,
      [courseId, blueprintNumber],
    );
    if (!bp) this.reject('blueprint_missing');
    if (course.current_blueprint_id === null || Number(course.current_blueprint_id) !== Number(bp.id)) this.reject('blueprint_not_current');
    if (Number(bp.structure_counter_at_lock) !== Number(course.structure_version_counter)) this.reject('structure_changed');

    let card: any;
    try {
      card = await this.design.recommend(courseId, ownerId, {} as any);
    } catch (err) {
      // Sin verificación no hay generación (falla cerrada); el detalle técnico queda en el log del servidor.
      this.reject('unverified', { detail: String((err as Error)?.message || err).slice(0, 300) });
    }
    if (!card || !card.design || !card.verification) this.reject('unverified');
    // Nada cambió mientras se verificaba (misma estructura que el Blueprint).
    const [after] = await this.dataSource.query(`select structure_version_counter from public.courses where id = $1`, [courseId]);
    if (!after || Number(after.structure_version_counter) !== Number(course.structure_version_counter)) this.reject('structure_changed');
    if (card.design.applicable !== true) this.reject('not_applicable');
    const proposed = (card.design.modules || []).reduce((n: number, m: any) => n + (m.chapters || []).filter((c: any) => c.proposed).length, 0);
    const pending = Math.max((card.design.changes || []).length, proposed);
    if (pending > 0) this.reject('pending_changes', { pendingChanges: pending });
    if (card.verification.blocking) {
      const criticals = (card.verification.checks || []).filter((c: any) => c.severity === 'critical' && !c.summary).map((c: any) => ({ id: c.id, area: c.area, title: c.title }));
      this.reject('critical', { criticals });
    }
    return { ok: true, structureCounter: Number(course.structure_version_counter), blueprintId: Number(bp.id) };
  }
}
