import { ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CourseDesignService } from './course-design.service';
import { assembleLockSnapshotV2, loadLockRows } from '../course-blueprints/lock-snapshot';
import { snapshotSha256V2 } from '../course-blueprints/blueprint-snapshot';

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

export type GenerationGateReason = 'blueprint_missing' | 'blueprint_not_current' | 'structure_changed' | 'design_changed' | 'design_not_saved' | 'unverified' | 'not_applicable' | 'pending_changes' | 'critical';

const MESSAGES: Record<GenerationGateReason, string> = {
  blueprint_missing: 'el curso no tiene una estructura aprobada para generar.',
  blueprint_not_current: 'la estructura aprobada que se quiere generar no es la vigente del curso.',
  structure_changed: 'la estructura cambió después de aprobarla; vuelve a revisarla y aprobarla en «Revisar y generar».',
  design_changed: 'el diseño cambió después de aprobarlo (horas, enfoque, contexto o configuración del curso); vuelve a revisarlo y aprobarlo en «Revisar y generar».',
  design_not_saved: 'el diseño verificado no es el guardado (horas, enfoque o audiovisual que propone Cursia sin guardar): usa «Usar este diseño» y vuelve a aprobarlo.',
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

  private async assertBlueprintMatchesLiveDesign(courseId: number, frozenSha: string, reason: GenerationGateReason = 'design_changed'): Promise<void> {
    const [course] = await this.dataSource.query(
      `select id, title, structure_version, structure_version_counter, current_blueprint_id, final_exam_enabled, activity_engine,
              (to_jsonb(courses) ->> 'review_cards_enabled')::boolean as review_cards_enabled
         from public.courses where id = $1`,
      [courseId],
    );
    const rows = await loadLockRows(this.dataSource as any, courseId);
    const assembled = await assembleLockSnapshotV2(this.dataSource as any, course, rows);
    if (assembled.errors.length > 0 || !assembled.snapshot) this.reject(reason);
    if (snapshotSha256V2(assembled.snapshot as any) !== frozenSha) this.reject(reason);
  }

  /** Re-review piloto M-c: un error de integridad al recomponer no es un 500 crudo (503: reintentar). */
  private async blueprintMatchesOr503(courseId: number, frozenSha: string, counterAtLock?: number): Promise<void> {
    try {
      // Mensaje preciso: si además avanzó el contador, cambió la ESTRUCTURA; si no, el perfil/contexto/configuración.
      let reason: GenerationGateReason = 'design_changed';
      if (counterAtLock !== undefined) {
        const [c] = await this.dataSource.query(`select structure_version_counter from public.courses where id = $1`, [courseId]);
        if (c && Number(c.structure_version_counter) !== Number(counterAtLock)) reason = 'structure_changed';
      }
      await this.assertBlueprintMatchesLiveDesign(courseId, frozenSha, reason);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new ServiceUnavailableException({ code: 'GENERATION_VERIFICATION_UNAVAILABLE', message: 'GENERATION_VERIFICATION_UNAVAILABLE: no se pudo comparar el diseño aprobado con el vigente; vuelve a intentarlo. No se generó nada.' });
    }
  }

  async assertVerified(courseId: number, ownerId: string, blueprintNumber: number): Promise<GenerationGateResult> {
    const [course] = await this.dataSource.query(
      `select id, structure_version_counter, current_blueprint_id from public.courses where id = $1 and owner_id = $2`,
      [courseId, ownerId],
    );
    if (!course) this.reject('blueprint_missing');
    const [bp] = await this.dataSource.query(
      `select id, schema_version, snapshot_sha256, structure_counter_at_lock from public.course_blueprints where course_id = $1 and blueprint_number = $2`,
      [courseId, blueprintNumber],
    );
    if (!bp) this.reject('blueprint_missing');
    if (course.current_blueprint_id === null || Number(course.current_blueprint_id) !== Number(bp.id)) this.reject('blueprint_not_current');
    // v2: la huella del snapshot (estructura + perfil + contexto + configuración) decide; el contador puede avanzar con
    // operaciones que no cambian lo que se genera (p. ej. «Usar este diseño» sin cambios, que devuelve el MISMO Blueprint
    // idempotente). v1 (sin perfil en el snapshot): el contador, como siempre.
    const v2 = Number(bp.schema_version) === 2;
    if (!v2 && Number(bp.structure_counter_at_lock) !== Number(course.structure_version_counter)) this.reject('structure_changed');
    // Review piloto C1: el Blueprint v2 congela también el perfil pedagógico (horas, enfoque), el contexto académico y la
    // configuración del curso, que NO avanzan el contador. Lo que se verifica abajo es lo vigente: debe ser exactamente lo
    // que se congeló (misma huella del snapshot recompuesto), o se verificaría una cosa y se generaría otra.
    if (v2) await this.blueprintMatchesOr503(courseId, String(bp.snapshot_sha256), Number(bp.structure_counter_at_lock));

    let card: any;
    try {
      card = await this.design.recommend(courseId, ownerId, {} as any);
    } catch (err) {
      // Sin verificación no hay generación (falla cerrada). Review piloto M4: un error de negocio (4xx) es «no verificado»;
      // uno transitorio (base de datos, red) es 503: reintentar luego, sin decir que el diseño está mal.
      if (err instanceof HttpException && err.getStatus() < 500) this.reject('unverified', { detail: String((err as Error)?.message || err).slice(0, 300) });
      throw new ServiceUnavailableException({ code: 'GENERATION_VERIFICATION_UNAVAILABLE', message: 'GENERATION_VERIFICATION_UNAVAILABLE: no se pudo verificar el diseño en este momento; vuelve a intentarlo en unos segundos. No se generó nada.' });
    }
    if (!card || !card.design || !card.verification) this.reject('unverified');
    // Nada cambió mientras se verificaba (misma estructura que el Blueprint).
    const [after] = await this.dataSource.query(`select structure_version_counter from public.courses where id = $1`, [courseId]);
    if (!after || (!v2 && Number(after.structure_version_counter) !== Number(course.structure_version_counter))) this.reject('structure_changed');
    // Re-review piloto M-d: tampoco cambió el perfil/contexto mientras se verificaba.
    if (v2) await this.blueprintMatchesOr503(courseId, String(bp.snapshot_sha256), Number(bp.structure_counter_at_lock));
    if (card.design.applicable !== true) this.reject('not_applicable');
    const proposed = (card.design.modules || []).reduce((n: number, m: any) => n + (m.chapters || []).filter((c: any) => c.proposed).length, 0);
    const pending = Math.max((card.design.changes || []).length, proposed);
    if (pending > 0) this.reject('pending_changes', { pendingChanges: pending });
    if (card.verification.blocking) {
      const criticals = (card.verification.checks || []).filter((c: any) => c.severity === 'critical' && !c.summary).map((c: any) => ({ id: c.id, area: c.area, title: c.title }));
      this.reject('critical', { criticals });
    }
    // (Al final: los cambios por aplicar y los críticos son lo primero que el docente debe ver.)
    // Re-review piloto P1: Verificación evaluó el perfil que muestra la tarjeta; debe ser el GUARDADO (el que congeló el
    // Blueprint). Si Cursia propone horas/enfoque/audiovisual sin guardar, se verificó otra cosa que la que se generaría.
    if (card.profileChanged === true) this.reject('design_not_saved');
    return { ok: true, structureCounter: Number(course.structure_version_counter), blueprintId: Number(bp.id) };
  }
}
