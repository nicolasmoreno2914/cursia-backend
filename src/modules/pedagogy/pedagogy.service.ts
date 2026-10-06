import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { academicBlueprintContext, loadCurrentAcademicContext } from '../academic-context/academic-db';
import { DataSource } from 'typeorm';
import { CoursesService } from '../courses/courses.service';
import {
  RawChapterRowV2,
  RawModuleRow,
  buildBlueprintSnapshotV2,
  validateBlueprintInputV2,
} from '../course-blueprints/blueprint-snapshot';
import { activityTypeRulesForNextManifest, readActivityTypeRulesConfig } from '../generation-manifests/manifest-rules-config';
import type { ActivityTypeRulesVersion } from '../generation-manifests/activity-type-rules';
import { defaultApproachRegistry } from './builtin-approaches';
import { DryRunInput, DryRunResult, runPedagogyDryRun } from './dry-run';
import { PEDAGOGY_ROLE_LABELS, PEDAGOGY_SECTION_LABELS, PEDAGOGY_TARGET_LABELS, PEDAGOGY_VALUE_LABELS } from './labels';
import { loadCurrentPedagogicalProfile } from './pedagogy-db';
import { PedagogyRecommendation, WIZARD_QUESTIONS, recommendApproaches } from './recommendation';
import { PEDAGOGY_ENGINE_VERSION } from './vocabulary';
import { plainCourseRefV2 } from '../course-blueprints/lock-snapshot';

/** Límites del dry-run en línea (lógica pura, pero sin estructuras gigantes). */
const MAX_DRY_RUN_MODULES = 20;
const MAX_DRY_RUN_CHAPTERS_PER_MODULE = 20;

/** Códigos de error de la lógica pura que son culpa de la entrada (→ 400). */
const INPUT_ERROR_RE = /^(PROFILE_INVALID|WIZARD_INVALID|DRY_RUN_INVALID|DRY_RUN_INVALID_STRUCTURE|APPROACH_UNKNOWN|BLUEPRINT_V2_INVALID_INPUT|BLUEPRINT_PEDAGOGY_INVALID)\b/;

function asBadRequest<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (INPUT_ERROR_RE.test(msg)) throw new BadRequestException(msg);
    throw err;
  }
}

/**
 * Motor pedagógico V1 — API. Todo es lectura + lógica pura: ningún endpoint
 * escribe, encola trabajos ni llama a un proveedor (el dry-run se detiene en
 * el Manifest). El perfil pedagógico se GUARDA por la API de perfiles de
 * siempre (POST /courses/:id/profiles/pedagogy).
 */
@Injectable()
export class PedagogyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly coursesService: CoursesService,
  ) {}

  catalog() {
    const registry = defaultApproachRegistry();
    return {
      engineVersion: PEDAGOGY_ENGINE_VERSION,
      approaches: registry.list().map((a) => ({ id: a.id, label: a.label, shortLabel: a.shortLabel, summary: a.summary, sequence: [...a.sequence] })),
      labels: { values: PEDAGOGY_VALUE_LABELS, sections: PEDAGOGY_SECTION_LABELS, targets: PEDAGOGY_TARGET_LABELS, roles: PEDAGOGY_ROLE_LABELS },
    };
  }

  wizard() {
    return { questions: WIZARD_QUESTIONS, approaches: defaultApproachRegistry().list().map((a) => ({ id: a.id, label: a.label })) };
  }

  recommend(answers: unknown): PedagogyRecommendation {
    return asBadRequest(() => recommendApproaches(answers));
  }

  private activityTypeRules(override: ActivityTypeRulesVersion | undefined): ActivityTypeRulesVersion {
    if (override !== undefined) return override;
    try {
      return readActivityTypeRulesConfig();
    } catch (err) {
      throw new BadRequestException(`Configuración inválida de reglas de actividad: ${(err as Error).message}`);
    }
  }

  dryRunInline(body: { structure: unknown; profile?: unknown; activityTypeRules?: ActivityTypeRulesVersion; applyStructureAdjustments?: boolean }): DryRunResult {
    const s: any = body.structure;
    const mods = Array.isArray(s?.modules) ? s.modules : [];
    if (mods.length > MAX_DRY_RUN_MODULES || mods.some((m: any) => Array.isArray(m?.chapters) && m.chapters.length > MAX_DRY_RUN_CHAPTERS_PER_MODULE)) {
      throw new BadRequestException(`DRY_RUN_INVALID_STRUCTURE: como máximo ${MAX_DRY_RUN_MODULES} módulos y ${MAX_DRY_RUN_CHAPTERS_PER_MODULE} capítulos por módulo`);
    }
    const input: DryRunInput = {
      structure: s,
      profile: body.profile ?? null,
      activityTypeRules: this.activityTypeRules(body.activityTypeRules),
      applyStructureAdjustments: body.applyStructureAdjustments,
    };
    return asBadRequest(() => runPedagogyDryRun(input));
  }

  /**
   * Dry-run sobre la estructura VIVA del curso (solo lectura: sin lock, sin Blueprint, sin Manifest
   * guardado). Perfil: el del cuerpo (vista previa sin guardar) o el vigente guardado.
   */
  async dryRunCourse(
    courseId: number,
    ownerId: string,
    body: { profile?: unknown; activityTypeRules?: ActivityTypeRulesVersion; applyStructureAdjustments?: boolean },
  ): Promise<DryRunResult & { profileSource: 'request' | 'saved' | 'none'; savedProfileVersion: number }> {
    const course = await this.coursesService.findOne(courseId, ownerId); // 404 si no es suyo
    if (course.structureVersion !== 'dynamic') {
      throw new BadRequestException(`El curso #${courseId} es "${course.structureVersion}" — esta API solo admite cursos "dynamic".`);
    }
    const [row] = await this.dataSource.query(
      `select id, title, final_exam_enabled, activity_engine,
              (to_jsonb(courses) ->> 'review_cards_enabled')::boolean as review_cards_enabled
         from public.courses where id = $1`,
      [courseId],
    );
    if (!row) throw new NotFoundException(`Course #${courseId} not found`);
    const modules: RawModuleRow[] = await this.dataSource.query(
      `select id, position, title, objective, description, exam_enabled from public.course_modules where course_id = $1`,
      [courseId],
    );
    const chapters: RawChapterRowV2[] = await this.dataSource.query(
      `select id, module_id, position, title, objective, description, video_enabled, activity_enabled,
              to_jsonb(course_chapters) ->> 'chapter_kind' as chapter_kind,
                to_jsonb(course_chapters) ->> 'application_minutes' as application_minutes,
                to_jsonb(course_chapters) -> 'outcome_ids' as outcome_ids
         from public.course_chapters where course_id = $1`,
      [courseId],
    );
    // Fase 3: el contexto académico guardado entra al Blueprint en memoria igual que en el lock.
    const academic = await loadCurrentAcademicContext(this.dataSource, courseId);
    // LOOP 7 (A1 I2): datos del curso de la fuente única (los mismos que el lock).
    const courseRef = plainCourseRefV2(row, academic ? academicBlueprintContext(academic.context, academic.sha256) : null);
    const errors = validateBlueprintInputV2(courseRef, modules, chapters);
    if (errors.length > 0) {
      throw new BadRequestException(`La estructura actual no se puede evaluar todavía: ${errors.map((e) => e.message).join('; ')}`);
    }
    const snapshot = buildBlueprintSnapshotV2(courseRef, modules, chapters);
    const saved = await loadCurrentPedagogicalProfile(this.dataSource, courseId);
    const fromRequest = body.profile !== undefined;
    const profile = fromRequest ? body.profile : saved?.profile ?? null;
    // LOOP 7 (A2 A3): las reglas de actividad con las que se congelará el PRÓXIMO Manifest del curso (fuente única).
    let atr: ActivityTypeRulesVersion;
    try {
      atr = body.activityTypeRules !== undefined ? body.activityTypeRules : await activityTypeRulesForNextManifest(this.dataSource, courseId);
    } catch (err) {
      throw new BadRequestException(`Configuración inválida de reglas de actividad: ${(err as Error).message}`);
    }
    const result = asBadRequest(() =>
      runPedagogyDryRun({
        structure: snapshot,
        profile,
        activityTypeRules: atr,
        applyStructureAdjustments: body.applyStructureAdjustments,
        // Fase 4: dato del contexto que no vive en el Blueprint (sugerencia P2 del Coherence Engine).
        alignment: { priorKnowledgeDeclared: academic ? academic.context.learner.priorKnowledge.status !== 'missing' : null },
      }),
    );
    return {
      ...result,
      profileSource: fromRequest ? 'request' : saved ? 'saved' : 'none',
      savedProfileVersion: saved?.version ?? 0,
    };
  }
}
