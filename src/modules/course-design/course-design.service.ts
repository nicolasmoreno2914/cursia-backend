import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CoursesService } from '../courses/courses.service';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import { PedagogyService } from '../pedagogy/pedagogy.service';
import { emptyPedagogicalProfile, normalizePedagogicalProfile } from '../pedagogy/pedagogy-profile';
import { loadCurrentPedagogicalProfile } from '../pedagogy/pedagogy-db';
import { loadCurrentAcademicContext } from '../academic-context/academic-db';
import { loadCourseFacts } from '../course-facts/course-facts-db';
import { isValidTargetHours } from '../study-time/target-hours';
import { defaultApproachRegistry } from '../pedagogy/builtin-approaches';
import { clearDesignPins, loadProposedHours, setProposedHours } from './design-pins';
import { ApproachSuggestion, proposeTargetHours, recommendApproachFromFacts } from './design-recommendation';
import { DesignAdjustDto, RecommendDesignDto } from './dto/recommend.dto';

/** Prioridad audiovisual por defecto de V2 (sin preferencia guardada). */
export const DEFAULT_AUDIOVISUAL = 'recommended' as const;
/** Meta provisoria para medir la estructura base cuando todavía no hay meta (baseHours no depende de la meta). */
const PROBE_TARGET_HOURS = 8;

/**
 * LOOP 8.3 · «Cursia recomienda». Arma el perfil EFECTIVO (lo guardado + lo que Cursia decide + «Ajustar») y corre el
 * MISMO dry-run que usa «Aplicar diseño» (estructura viva, valores fijados, distribuidor, materialización del Blueprint y
 * el Manifest con su costo). La tarjeta muestra ese resultado; aplicar recalcula y exige la misma huella
 * (proposalSha256): lo que se ve es lo que se congela. Sin escrituras (salvo «Liberar»), sin proveedores, USD 0.
 */
@Injectable()
export class CourseDesignService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly coursesService: CoursesService,
    private readonly pedagogy: PedagogyService,
  ) {}

  private async loadCourse(courseId: number, ownerId: string) {
    const course = await this.coursesService.findOne(courseId, ownerId); // 404 si no es suyo
    if (course.structureVersion !== 'dynamic') {
      throw new BadRequestException(`El curso #${courseId} es "${course.structureVersion}" — esta API solo admite cursos "dynamic".`);
    }
  }

  async recommend(courseId: number, ownerId: string, dto: RecommendDesignDto) {
    await this.loadCourse(courseId, ownerId);
    const adjust: DesignAdjustDto = (dto && dto.adjust) || {};
    if (adjust.targetHours !== undefined && adjust.targetHours !== 'auto' && !isValidTargetHours(adjust.targetHours)) {
      throw new BadRequestException('targetHours debe ser «auto» o un número de 1 a 500, en pasos de media hora.');
    }
    const registry = defaultApproachRegistry();
    if (adjust.approach !== undefined && adjust.approach !== 'recommended' && !registry.has(adjust.approach)) {
      throw new BadRequestException(`Enfoque desconocido: ${JSON.stringify(adjust.approach)}`);
    }
    const saved = await loadCurrentPedagogicalProfile(this.dataSource, courseId);
    // Review L83 M-7: solo una base sin la tabla de perfiles se trata como «sin contexto»; cualquier otro error se ve.
    const academic = await loadCurrentAcademicContext(this.dataSource, courseId).catch((err) => {
      if (err && (err as { code?: string }).code === '42P01') return null;
      throw err;
    });
    const proposedHours = await loadProposedHours(this.dataSource, courseId);
    const facts = await loadCourseFacts(this.dataSource, courseId);
    const base: any = saved ? JSON.parse(JSON.stringify(saved.profile)) : emptyPedagogicalProfile();
    delete base.designRules;

    // Enfoque: el guardado manda; sin enfoque (o «recommended» en Ajustar), el que recomienda Cursia.
    const outcomes = academic && academic.context.outcomes.length
      ? academic.context.outcomes.map((o) => o.text)
      : [...((base.learningOutcomes && base.learningOutcomes.know) || []), ...((base.learningOutcomes && base.learningOutcomes.do) || [])];
    const suggestion: ApproachSuggestion | null = recommendApproachFromFacts({
      learner: base.learner || null,
      outcomes,
      competencies: academic ? academic.context.competencies.map((c) => c.text) : ((base.learningOutcomes && base.learningOutcomes.competencies) || []),
    });
    let approachSource: 'saved' | 'recommended' | 'adjusted' | 'none' = base.primaryApproach ? 'saved' : 'none';
    if (adjust.approach && adjust.approach !== 'recommended') {
      if (adjust.approach !== base.primaryApproach) { base.primaryApproach = adjust.approach; base.secondaryApproaches = (base.secondaryApproaches || []).filter((x: string) => x !== adjust.approach); approachSource = 'adjusted'; }
    } else if (!base.primaryApproach || adjust.approach === 'recommended') {
      if (suggestion) { base.primaryApproach = suggestion.approach; base.secondaryApproaches = (base.secondaryApproaches || []).filter((x: string) => x !== suggestion.approach); approachSource = 'recommended'; }
    }

    // Preferencias de diseño (V2: la prioridad audiovisual siempre explícita; por defecto, la recomendada).
    const prefs: any = { ...(base.designPreferences || {}) };
    if (adjust.emphasis !== undefined) prefs.emphasis = adjust.emphasis;
    if (adjust.applicationActivities !== undefined) prefs.applicationActivities = adjust.applicationActivities;
    if (adjust.audiovisual !== undefined) prefs.audiovisual = adjust.audiovisual;
    if (!prefs.audiovisual) prefs.audiovisual = DEFAULT_AUDIOVISUAL;
    base.designPreferences = prefs;

    // Horas: la meta explícita (docente o documento) NUNCA se redondea; sin meta, la propone Cursia.
    // Review L83 I-4: sin horas en el perfil, las del documento (las mismas que muestra «Lo que entendimos»).
    if (typeof base.targetHours !== 'number' && adjust.targetHours === undefined && facts.targetHours.source === 'document' && typeof facts.targetHours.value === 'number') {
      base.targetHours = facts.targetHours.value;
    }
    let hoursSource: 'user' | 'document' | 'proposed' | 'adjusted' =
      typeof proposedHours === 'number' && base.targetHours === proposedHours ? 'proposed'
        : facts.targetHours.source === 'document' ? 'document' : 'user';
    let proposal: ReturnType<typeof proposeTargetHours> | null = null;
    if (typeof adjust.targetHours === 'number') {
      if (adjust.targetHours !== base.targetHours) hoursSource = 'adjusted';
      base.targetHours = adjust.targetHours;
    } else if (adjust.targetHours === 'auto' || typeof base.targetHours !== 'number') {
      const probe = await this.pedagogy.dryRunCourse(courseId, ownerId, { profile: normalizePedagogicalProfile({ ...base, targetHours: PROBE_TARGET_HOURS }) });
      const baseHours = probe.distribution ? probe.distribution.baseHours : probe.baseline.studyTime.courseEstimatedHours;
      proposal = proposeTargetHours(baseHours);
      base.targetHours = proposal.value;
      hoursSource = 'proposed';
    }

    const profile = normalizePedagogicalProfile(base);
    const dr = await this.pedagogy.dryRunCourse(courseId, ownerId, { profile });
    const dist = dr.distribution;
    const chapterOutcomes = await this.chapterOutcomes(courseId);
    const savedComparable = saved ? JSON.stringify(normalizePedagogicalProfile(Object.fromEntries(Object.entries(saved.profile as any).filter(([k]) => k !== 'designRules')))) : null;
    const approachDef = profile.primaryApproach ? registry.get(profile.primaryApproach) : null;
    const providers = dist && dist.materialized ? dist.materialized.providers : null;
    return {
      designVersion: 1,
      providersCalled: 0,
      profile,
      profileVersion: saved ? saved.version : 0,
      /** El perfil que se recomienda difiere del guardado: «Usar este diseño» lo guarda antes de aplicar. */
      profileChanged: savedComparable !== JSON.stringify(profile),
      approach: profile.primaryApproach
        ? { id: profile.primaryApproach, label: approachDef ? approachDef.label : profile.primaryApproach, source: approachSource,
          reasons: approachSource === 'recommended' && suggestion ? suggestion.reasons : [] }
        : null,
      hours: { target: profile.targetHours ?? null, source: hoursSource, ...(proposal ? { proposedFrom: proposal.base, reason: proposal.reason } : hoursSource === 'proposed' ? { reason: `Cursia propuso ${profile.targetHours} h para este curso.` } : {}) },
      preferences: { emphasis: prefs.emphasis || 'balanced', applicationActivities: prefs.applicationActivities || 'auto', audiovisual: prefs.audiovisual },
      // Review L83 M-1: solo los fijados que el diseño usa (capítulos de contenido que existen).
      pinnedChapters: dist ? dist.modules.reduce((n, m) => n + m.chapters.filter((c) => c.videoPinned && c.kind === 'content' && !c.proposed).length, 0) : 0,
      design: dist
        ? {
          status: dist.status,
          estimatedHours: dist.estimatedHours,
          toleranceHours: dist.toleranceHours,
          baseHours: dist.baseHours,
          counts: dist.counts,
          hoursByComponent: dist.hoursByComponent,
          recommendations: dist.recommendations,
          proposalSha256: dist.proposalSha256,
          manifestErrors: dist.materialized ? dist.materialized.manifestErrors : [],
          applicable: dist.status !== 'minimum_exceeds_target' && !!dist.materialized && !dist.materialized.manifestErrors.length,
          changes: dist.changes,
          modules: dist.modules.map((m) => ({
            id: m.id, title: m.title, examEnabled: m.examEnabled,
            chapters: m.chapters.map((c) => ({
              id: c.id, proposed: c.proposed, kind: c.kind, title: c.title, role: c.role, videoEnabled: c.videoEnabled, videoPinned: c.videoPinned,
              activityEnabled: c.activityEnabled, review: c.review, applicationMinutes: c.applicationMinutes, hours: Math.round((c.targetMinutes / 60) * 10) / 10,
              outcomeIds: chapterOutcomes.get(c.id) || [],
            })),
          })),
        }
        : null,
      cost: providers && providers.estimateUsd ? { min: providers.estimateUsd.min, expected: providers.estimateUsd.expected, max: providers.estimateUsd.max, note: providers.estimateNote } : null,
      outcomes: academic ? academic.context.outcomes.map((o) => ({ id: o.id, text: o.text })) : [],
    };
  }

  /**
   * Review L83 I-3: «Usar este diseño» con horas que propuso Cursia → quedan registradas como propuestas (no del docente);
   * con horas del docente o del documento, el registro se borra. Valida contra el perfil guardado: nunca se marca como
   * propuesto un valor distinto del vigente.
   */
  async recordHoursOrigin(courseId: number, ownerId: string, proposed: number | null) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    if (proposed !== null) {
      if (!isValidTargetHours(proposed)) throw new BadRequestException('proposed debe ser un número de 1 a 500, en pasos de media hora, o null.');
      const saved = await loadCurrentPedagogicalProfile(this.dataSource, courseId);
      if (!saved || (saved.profile as any).targetHours !== proposed) {
        throw new BadRequestException('HOURS_NOT_SAVED: guarda primero el perfil con esas horas.');
      }
    }
    await setProposedHours(this.dataSource, courseId, proposed);
    return { proposed };
  }

  /** «Liberar»: los valores fijados vuelven a decidirlos Cursia. */
  async clearPins(courseId: number, ownerId: string) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const released = await clearDesignPins(this.dataSource, courseId);
    return { released };
  }

  private async chapterOutcomes(courseId: number): Promise<Map<string, string[]>> {
    const rows: { id: string; outcome_ids: unknown }[] = await this.dataSource.query(
      `select id, to_jsonb(ch) -> 'outcome_ids' as outcome_ids from public.course_chapters ch where course_id = $1`,
      [courseId],
    );
    return new Map(rows.map((r) => [r.id, Array.isArray(r.outcome_ids) ? (r.outcome_ids as string[]) : []]));
  }
}
