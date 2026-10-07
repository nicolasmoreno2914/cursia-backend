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
import { clearDesignPins, loadDesignPins, loadProposedHours, setProposedHours } from './design-pins';
import { ApproachSuggestion, proposeTargetHours, recommendApproachFromFacts } from './design-recommendation';
import { verifyDesign } from './design-verification';
import { returningRows } from '../../common/db/returning-rows';
import { LINK_CONTAINMENT_MIN, suggestOutcomeLinks } from '../academic-context/context-design';
import type { AcademicContextV1 } from '../academic-context/academic-context';
import { tokenSet } from '../coherence/normalize';
import { proposedChapterUuid } from '../pedagogy/dry-run';
import { advanceStructureOriginIfUntouched, readStructureOrigin } from '../course-structure/structure-authority';
import { compareRequirements, DesignForRequirements, RequirementCheck } from '../academic-context/requirements/document-requirements';
import {
  DECISION_DEFAULTS, DecisionOverrides, constraintsFor, EXCEPTION_FIELDS, structureEditedByTeacher, EXCEPTION_VALUES, ExceptionField, hoursFromRequirements, loadExceptions, loadRequirementAuthority,
  requirementText, requirementVerificationChecks, teacherDecisions, writeExceptions,
} from '../academic-context/requirements/requirement-authority';
import { DistributionResult } from '../study-time/distributor';
import { ConflictException } from '@nestjs/common';
import { DesignAdjustDto, RecommendDesignDto, RequirementDecisionsDto } from './dto/recommend.dto';

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

    // LOOP 8.6C · requisitos del documento: los que aplican (alternativa elegida) y las decisiones del docente (las
    // registradas por «Usar este diseño» + las de «Ajustar» en esta vista previa).
    const auth = await loadRequirementAuthority(this.dataSource, courseId, academic ? academic.context.documents : []);
    const decisionOverrides: DecisionOverrides = {
      set: { ...(adjust.audiovisual ? { audiovisual: adjust.audiovisual } : {}), ...(adjust.applicationActivities ? { applicationActivities: adjust.applicationActivities } : {}) },
      clear: (dto && dto.clearDecisions) || [],
    };
    // Review L86C I1: decisiones del docente = las implícitas (lo guardado en el perfil, p. ej. desde «Avanzado») + las
    // registradas + las de «Ajustar», menos las que devuelve al documento.
    const savedPrefs: any = saved ? ((saved.profile as any).designPreferences || null) : null;
    const decisions = teacherDecisions(auth, savedPrefs, decisionOverrides);
    for (const f of EXCEPTION_FIELDS) {
      if (adjust[f] !== undefined) continue;
      if (decisions[f]) prefs[f] = decisions[f]!.value as any;
      // «Volver al requisito del documento»: la preferencia vuelve al valor por defecto (el perfil guardado queda coherente).
      else if (decisionOverrides.clear && decisionOverrides.clear.includes(f)) prefs[f] = DECISION_DEFAULTS[f] as any;
    }
    // «Video en todos los capítulos» que exige el documento (sin decisión del docente): la preferencia lo dice («Más
    // video») para que la tarjeta y «Ajustar» no muestren otra cosa; queda registrada como elección de Cursia. Va antes
    // de calcular las horas (re-review L86C m4: la sonda usa la misma prioridad que el diseño).
    const previewConstraints = constraintsFor(auth.required, decisions);
    const forceAllVideo = !!(previewConstraints && previewConstraints.videosAllContent && !decisions.audiovisual);
    if (forceAllVideo) prefs.audiovisual = 'more';
    // Re-review L86C m1: una prioridad que eligió Cursia y ya nada exige vuelve al valor por defecto (si la búsqueda de
    // abajo la necesita otra vez, la vuelve a elegir).
    else if (!decisions.audiovisual && auth.cursia && auth.cursia.audiovisual && prefs.audiovisual === auth.cursia.audiovisual) prefs.audiovisual = DECISION_DEFAULTS.audiovisual;
    base.designPreferences = prefs;

    // Horas: la meta explícita (docente o documento) NUNCA se redondea; sin meta, la propone Cursia.
    // Review L83 I-4: sin horas en el perfil, las del documento (las mismas que muestra «Lo que entendimos»).
    if (typeof base.targetHours !== 'number' && adjust.targetHours === undefined && facts.targetHours.source === 'document' && typeof facts.targetHours.value === 'number') {
      base.targetHours = facts.targetHours.value;
    }
    let hoursSource: 'user' | 'document' | 'proposed' | 'adjusted' | 'requirement' =
      typeof proposedHours === 'number' && base.targetHours === proposedHours ? 'proposed'
        : facts.targetHours.source === 'document' ? 'document' : 'user';
    let proposal: ReturnType<typeof proposeTargetHours> | null = null;
    if (typeof adjust.targetHours === 'number') {
      // Review L83-2 m1: horas escritas en «Ajustar» son del docente aunque coincidan con las que propuso Cursia.
      hoursSource = 'adjusted';
      base.targetHours = adjust.targetHours;
    } else if (adjust.targetHours === 'auto' || typeof base.targetHours !== 'number') {
      const probe = await this.pedagogy.dryRunCourse(courseId, ownerId, { profile: normalizePedagogicalProfile({ ...base, targetHours: PROBE_TARGET_HOURS }), requirementDecisions: decisionOverrides });
      const baseHours = probe.distribution ? probe.distribution.baseHours : probe.baseline.studyTime.courseEstimatedHours;
      proposal = proposeTargetHours(baseHours);
      base.targetHours = proposal.value;
      hoursSource = 'proposed';
    }

    // LOOP 8.6C · horas del documento: mandan sobre lo que propone Cursia o lo que traía el contexto; las que el docente
    // escribió se respetan (si se apartan del documento, quedan como excepción en Verificación).
    let hoursRequirement: ReturnType<typeof hoursFromRequirements> = null;
    if (hoursSource !== 'user' && hoursSource !== 'adjusted') {
      const hr = hoursFromRequirements(auth.applicable, typeof base.targetHours === 'number' ? base.targetHours : null);
      if (hr && (hr.required || hoursSource === 'proposed')) {
        base.targetHours = hr.value;
        // Las mismas horas que ya traía el microcurrículo (8.1) siguen siendo «del documento» (no es un ajuste de Cursia).
        hoursSource = hr.required && facts.targetHours.source === 'document' && facts.targetHours.value === hr.value ? 'document' : 'requirement';
        hoursRequirement = hr;
        proposal = null;
      }
    }

    let profile = normalizePedagogicalProfile(base);
    let dr = await this.pedagogy.dryRunCourse(courseId, ownerId, { profile, requirementDecisions: decisionOverrides });
    const applied: { requirementId: string; text: string }[] = [];
    if (hoursRequirement && hoursSource === 'requirement') {
      applied.push({ requirementId: hoursRequirement.requirement.id, text: `Horas de trabajo del estudiante: ${String(base.targetHours).replace('.', ',')} h (el documento ${hoursRequirement.required ? 'pide' : 'sugiere'} ${requirementText(hoursRequirement.requirement)}).` });
    }
    // LOOP 8.6C · cantidad de videos del curso o por módulo: la prioridad audiovisual que la cumpla (si el docente no
    // eligió una). Si ninguna la cumple, Verificación lo explica (Cursia no inventa videos de más ni de menos).
    const videoReqs = auth.required.filter((r) => r.kind === 'videos' && (r.scope.level === 'course' || (r.scope.level === 'module' && 'each' in r.scope)));
    let cursiaAudiovisual: string | null = auth.cursia && auth.cursia.audiovisual && prefs.audiovisual === auth.cursia.audiovisual ? auth.cursia.audiovisual : null;
    if (forceAllVideo) cursiaAudiovisual = 'more';
    // Re-review L86C m-2: si el docente decidió la prioridad audiovisual, ya no es «de Cursia» (aunque coincida).
    if (decisions.audiovisual) cursiaAudiovisual = null;
    const meetsVideos = (d: DistributionResult) => compareRequirements(videoReqs, designForRequirements(d, null, 'proposed', false, false, false)).every((c) => c.status === 'met');
    if (videoReqs.length && dr.distribution && !decisions.audiovisual) {
      const meets = meetsVideos;
      if (!meets(dr.distribution)) {
        for (const cand of ['recommended', 'more', 'less'] as const) {
          if (cand === prefs.audiovisual) continue;
          const b2 = { ...base, designPreferences: { ...prefs, audiovisual: cand } };
          const p2 = normalizePedagogicalProfile(b2);
          const d2 = await this.pedagogy.dryRunCourse(courseId, ownerId, { profile: p2, requirementDecisions: decisionOverrides });
          // Review L86C M6: una prioridad que cumple los videos pero deja el diseño por encima de las horas no sirve.
          if (d2.distribution && meets(d2.distribution) && (d2.distribution.status !== 'minimum_exceeds_target' || dr.distribution.status === 'minimum_exceeds_target')) {
            cursiaAudiovisual = cand;
            profile = p2;
            dr = d2;
            prefs.audiovisual = cand;
            base.designPreferences = b2.designPreferences;
            applied.push({ requirementId: videoReqs[0].id, text: `Contenido audiovisual: «${({ less: 'Menos video', recommended: 'Recomendado', more: 'Más video' } as const)[cand]}» para cumplir ${requirementText(videoReqs[0])}.` });
            break;
          }
        }
      }
    }
    const dist = dr.distribution;
    if (dist) {
      const byReq = new Map<string, number>();
      for (const ch of dist.changes) if (ch.requirementId) byReq.set(ch.requirementId, (byReq.get(ch.requirementId) || 0) + 1);
      for (const [rid, n] of byReq) {
        const r = auth.applicable.find((x) => x.id === rid);
        if (r) applied.push({ requirementId: rid, text: `${n === 1 ? 'Un capítulo propuesto' : `${n} capítulos propuestos`} para llegar a ${requirementText(r)}.` });
      }
    }
    const live = await this.liveChapters(courseId);
    const chapterOutcomes = new Map(live.map((r) => [r.id, r.outcomeIds]));
    const linkPlan = academic && dist ? await autoLinkPlan(this.dataSource, courseId, academic.context) : [];
    const savedComparable = saved ? JSON.stringify(normalizePedagogicalProfile(Object.fromEntries(Object.entries(saved.profile as any).filter(([k]) => k !== 'designRules')))) : null;
    const approachDef = profile.primaryApproach ? registry.get(profile.primaryApproach) : null;
    const providers = dist && dist.materialized ? dist.materialized.providers : null;
    const pinnedChapters = dist ? dist.modules.reduce((n, m) => n + m.chapters.filter((c) => !c.proposed && ((c.videoPinned && c.kind === 'content') || c.applicationPinned)).length, 0) : 0;
    // LOOP 8.6B/8.6C · requisitos del documento frente a ESTE diseño: cumplimiento, excepciones del docente y conflictos.
    let reqChecks: RequirementCheck[] = [];
    let requirementChecks: ReturnType<typeof requirementVerificationChecks> = [];
    if (auth.view.state === 'current' && dist) {
      const origin = await readStructureOrigin(this.dataSource, courseId);
      const [cnt] = await this.dataSource.query(`select structure_version_counter c from public.courses where id = $1`, [courseId]);
      // Review piloto I5: misma regla que las restricciones (la forma de la estructura, no cualquier edición).
      const structureByTeacher = await structureEditedByTeacher(this.dataSource, courseId);
      reqChecks = compareRequirements(auth.applicable, designForRequirements(dist, profile.targetHours ?? null, hoursSource === 'requirement' ? 'proposed' : hoursSource,
        structureByTeacher, !!decisions.audiovisual, !!decisions.applicationActivities));
      const teacherPins = dist.modules.some((m) => m.chapters.some((c) => !c.proposed && (c.videoPinned || c.applicationPinned)));
      // Re-review final L86C: la causa de un choque de horas se averigua, no se adivina — el mismo diseño SIN las decisiones
      // ni lo fijado por el docente. Si el choque persiste, es entre requisitos del documento (crítico), salvo que la
      // estructura del docente se aparte del documento; si desaparece, es la excepción del docente.
      let clashCause: 'teacher' | 'document' | null = null;
      let clashWith: { requirement: (typeof videoReqs)[number]; hours: number } | null = null;
      const clash = dist.status === 'minimum_exceeds_target' || dist.status === 'cannot_reach_target';
      const decided = EXCEPTION_FIELDS.some((f) => !!decisions[f]) || teacherPins;
      const hoursRequired = auth.required.some((r) => r.kind === 'target_hours');
      if (clash && hoursRequired && (decided || structureByTeacher) && hoursSource !== 'user' && hoursSource !== 'adjusted') {
        // Sin decisiones ni fijados el cálculo sería idéntico: el choque persiste (re-review final m-4).
        let persists = true;
        if (decided) {
          const cfPrefs: any = { ...prefs };
          // El video que exige el documento lo impone el distribuidor; la prioridad vuelve a la de por defecto (m-1).
          for (const f of EXCEPTION_FIELDS) if (decisions[f]) cfPrefs[f] = DECISION_DEFAULTS[f];
          // La prioridad audiovisual SIEMPRE se recalcula como la elegiría Cursia sin el docente (la guardada pudo elegirse
          // con lo que él fijó): «Más video» si el documento exige video en todos los capítulos; si no, la de por defecto.
          const noTeacher = constraintsFor(auth.required, {});
          cfPrefs.audiovisual = noTeacher && noTeacher.videosAllContent ? 'more' : DECISION_DEFAULTS.audiovisual;
          const cfRun = (audiovisual: string) => this.pedagogy.dryRunCourse(courseId, ownerId, {
            profile: normalizePedagogicalProfile({ ...base, designPreferences: { ...cfPrefs, audiovisual } }), requirementDecisions: { clear: [...EXCEPTION_FIELDS] }, ignorePins: true,
          });
          // Re-review final L86C: ¿puede Cursia, sin el docente, cumplir a la vez la cantidad de videos del documento y sus
          // horas? Si alguna prioridad cumple las dos → el choque es del docente. Si los videos solo se cumplen pasándose
          // de las horas → documento contra documento (crítico). Si ninguna llega a los videos, ese requisito no se puede
          // cumplir por sí solo (tiene su propio aviso) y las horas se juzgan con la prioridad de por defecto.
          const isClash = (d: Awaited<ReturnType<typeof cfRun>>) => !d.distribution || d.distribution.status === 'minimum_exceeds_target' || d.distribution.status === 'cannot_reach_target';
          const first = await cfRun(cfPrefs.audiovisual);
          persists = isClash(first);
          if (videoReqs.length && first.distribution && !meetsVideos(first.distribution)) {
            let videosAt: number | null = null;
            let both = false;
            for (const cand of (['recommended', 'more', 'less'] as const).filter((c) => c !== cfPrefs.audiovisual)) {
              const d = await cfRun(cand);
              if (!d.distribution || !meetsVideos(d.distribution)) continue;
              if (!isClash(d)) { both = true; break; }
              if (videosAt === null) videosAt = d.distribution.status === 'minimum_exceeds_target' ? d.distribution.baseHours : d.distribution.estimatedHours;
            }
            if (both) persists = false;
            else if (videosAt !== null) { persists = true; clashWith = { requirement: videoReqs[0], hours: videosAt }; }
          }
        }
        const teacherStructureOff = structureByTeacher && reqChecks.some((c) => c.status === 'unmet' && c.chosenBy === 'teacher'
          && ['modules', 'chapters', 'structure'].includes((auth.applicable.find((r) => r.id === c.requirementId) || { kind: '' }).kind));
        clashCause = !persists || teacherStructureOff ? 'teacher' : 'document';
      }
      requirementChecks = requirementVerificationChecks(auth.applicable, reqChecks, {
        clashCause, structureByTeacher, clashWith,
        status: dist.status, baseHours: dist.baseHours, estimatedHours: dist.estimatedHours, hoursByTeacher: hoursSource === 'user' || hoursSource === 'adjusted',
        teacherPins,
        modules: dist.modules.length, moduleExams: dist.modules.filter((m) => m.examEnabled).length,
        exceptionFields: Object.fromEntries(EXCEPTION_FIELDS.filter((f) => decisions[f]).map((f) => [f, decisions[f]!.value])) as Partial<Record<ExceptionField, string>>,
      });
      // Review L86C M1: cada comparación lleva la severidad que le da Verificación (la interfaz no la contradice).
      const vc = new Map(requirementChecks.map((c) => [c.id, c]));
      reqChecks = reqChecks.map((c) => {
        const v = vc.get(`requirement:${c.requirementId}`);
        return v ? { ...c, severity: v.severity, ...(v.detail ? { detail: v.detail } : {}) } : c;
      });
    }
    // LOOP 8.4: la verificación del MISMO diseño (alineación del Coherence Engine incluida).
    const verification = dist
      ? verifyDesign({
        status: dist.status, targetHours: dist.targetHours, estimatedHours: dist.estimatedHours, toleranceHours: dist.toleranceHours, baseHours: dist.baseHours,
        counts: dist.counts, manifestErrors: dist.materialized ? dist.materialized.manifestErrors : [{ code: 'NOT_MATERIALIZED' }],
        alignment: dist.materialized ? (dist.materialized as any).alignment : null,
        approach: profile.primaryApproach ? { id: profile.primaryApproach, label: approachDef ? approachDef.label : profile.primaryApproach } : null,
        policyKind: dist.policy ? dist.policy.kind : null, audiovisual: prefs.audiovisual || null, pinnedChapters,
        cost: providers && providers.estimateUsd ? providers.estimateUsd : null,
        preferences: { emphasis: prefs.emphasis || 'balanced', applicationActivities: prefs.applicationActivities || 'auto' },
        autoLink: {
          chapterIds: linkPlan.map((p) => p.chapterId),
          outcomeIds: [...new Set(linkPlan.flatMap((p) => p.suggested))],
          preview: linkPlan.map((p) => ({ chapter: p.title, outcomes: p.suggested })),
        },
        proposedChapterIds: dist.modules.flatMap((m) => m.chapters.filter((c) => c.proposed).map((c) => proposedChapterUuid(c.id))),
        uncoveredContents: academic ? uncoveredUnitContents(academic.context, live) : [],
        requiredEvaluations: academic ? academic.context.evaluation.map((e) => e.instrument).filter(Boolean) : [],
        pinnedApplicationsOutsideMode: dist.modules.flatMap((m) => m.chapters.filter((c) => c.applicationPinned && c.applicationMinutes
          && ((prefs.applicationActivities || 'auto') === 'none' || ((prefs.applicationActivities || 'auto') === 'practice_only' && c.kind !== 'practice'))).map((c) => c.id)),
        uncoveredEvaluations: academic ? uncoveredEvaluations(academic.context, dist, chapterOutcomes) : [],
        requirementChecks,
      })
      : null;
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
      hours: { target: profile.targetHours ?? null, source: hoursSource, ...(proposal ? { proposedFrom: proposal.base, reason: proposal.reason } : hoursSource === 'proposed' ? { reason: `Cursia propuso ${profile.targetHours} h para este curso.` }
        : hoursSource === 'requirement' && hoursRequirement ? { reason: hoursRequirement.required ? `Horas del documento: ${requirementText(hoursRequirement.requirement)}.` : `Horas que sugiere el documento (${requirementText(hoursRequirement.requirement)}); puedes cambiarlas en «Ajustar».` } : {}) },
      preferences: { emphasis: prefs.emphasis || 'balanced', applicationActivities: prefs.applicationActivities || 'auto', audiovisual: prefs.audiovisual },
      // Review L83 M-1: solo los fijados que el diseño usa (capítulos de contenido que existen).
      pinnedChapters,
      verification,
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
              id: c.id, proposed: c.proposed, kind: c.kind, title: c.title, role: c.role, videoEnabled: c.videoEnabled, videoPinned: c.videoPinned, applicationPinned: c.applicationPinned,
              activityEnabled: c.activityEnabled, review: c.review, applicationMinutes: c.applicationMinutes, hours: Math.round((c.targetMinutes / 60) * 10) / 10,
              outcomeIds: chapterOutcomes.get(c.id) || [],
            })),
          })),
        }
        : null,
      cost: providers && providers.estimateUsd ? { min: providers.estimateUsd.min, expected: providers.estimateUsd.expected, max: providers.estimateUsd.max, note: providers.estimateNote } : null,
      outcomes: academic ? academic.context.outcomes.map((o) => ({ id: o.id, text: o.text })) : [],
      requirements: {
        ...auth.view,
        checks: reqChecks,
        // LOOP 8.6C · cómo se diseñó dentro de los requisitos y qué decisiones del docente registrar al usarlo.
        authority: {
          applied,
          decisions: Object.fromEntries(EXCEPTION_FIELDS.map((f) => [f, decisions[f] ? decisions[f]!.value : null])),
          // Review L86C I1: lo que eligió Cursia para cumplir el documento (se registra al usar el diseño).
          cursiaAudiovisual,
          hours: hoursRequirement ? { requirementId: hoursRequirement.requirement.id, value: base.targetHours, required: hoursRequirement.required } : null,
        },
      },
    };
  }

  /**
   * LOOP 8.6C · «Usar este diseño» registra las decisiones del docente que pueden apartarse del documento (prioridad
   * audiovisual, modo de Actividades de Aplicación). null quita la decisión (vuelve a mandar el documento). Sin
   * requisitos leídos de los documentos del curso no hay nada que registrar.
   */
  async saveRequirementDecisions(courseId: number, ownerId: string, dto: RequirementDecisionsDto) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const academic = await loadCurrentAcademicContext(this.dataSource, courseId).catch((err) => {
      if (err && (err as { code?: string }).code === '42P01') return null;
      throw err;
    });
    return this.dataSource.transaction(async (m) => {
      await m.query(`select id from public.courses where id = $1 for update`, [courseId]);
      const auth = await loadRequirementAuthority(m, courseId, academic ? academic.context.documents : []);
      const prev = await loadExceptions(m, courseId);
      if (!auth.key) {
        // Re-review final L86C IMPORTANTE-A: sin lectura no hay decisiones que registrar, pero lo que eligió Cursia se
        // actualiza igual; si no, un «Más video» viejo de Cursia haría pasar por suyo el «Más video» que elige el docente.
        if (prev) {
          // Una decisión vieja que el docente ya cambió no debe volver a mandar si regresa el mismo documento (m-1).
          const fields = { ...prev.fields };
          for (const f of EXCEPTION_FIELDS) {
            const v = (dto as Record<string, unknown>)[f];
            if (v !== undefined && fields[f] && fields[f]!.value !== v) delete fields[f];
          }
          let cursia = prev.cursia;
          if (dto.cursiaAudiovisual !== undefined) {
            const av = dto.cursiaAudiovisual && EXCEPTION_VALUES.audiovisual.includes(dto.cursiaAudiovisual) ? dto.cursiaAudiovisual : null;
            cursia = av ? { audiovisual: av } : undefined;
          }
          if (fields.audiovisual) cursia = undefined;
          await writeExceptions(m, courseId, { key: prev.key, fields, ...(cursia ? { cursia } : {}) });
        }
        return { stored: false, decisions: {} };
      }
      const fields = prev && prev.key === auth.key ? { ...prev.fields } : {};
      for (const f of EXCEPTION_FIELDS) {
        const v = (dto as Record<string, unknown>)[f];
        if (v === undefined) continue;
        if (v === null) delete fields[f];
        else fields[f] = { value: String(v), at: new Date().toISOString() };
      }
      // Re-review L86C IMP-1: lo que eligió Cursia sigue siéndolo aunque cambien los documentos.
      let cursia = prev ? prev.cursia : undefined;
      if (dto.cursiaAudiovisual !== undefined) {
        cursia = dto.cursiaAudiovisual && EXCEPTION_VALUES.audiovisual.includes(dto.cursiaAudiovisual) ? { audiovisual: dto.cursiaAudiovisual } : undefined;
      }
      if (fields.audiovisual) cursia = undefined; // la decisión del docente manda (re-review final m-5)
      await writeExceptions(m, courseId, { key: auth.key, fields, ...(cursia ? { cursia } : {}) });
      return { stored: true, decisions: Object.fromEntries(EXCEPTION_FIELDS.map((f) => [f, fields[f] ? fields[f]!.value : null])) };
    });
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

  /**
   * LOOP 8.4 · «Corregir» automático. Solo lo que no toca ninguna decisión del docente:
   *   link_outcomes — vincula a sus resultados los capítulos que NO tienen vínculos propios (la misma sugerencia del
   *   contexto académico; un capítulo con vínculos se conserva siempre). Una transacción, con el contador de la estructura.
   */
  async fix(courseId: number, ownerId: string, action: string, expectedCounter: number) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    if (action !== 'link_outcomes') throw new BadRequestException(`Acción desconocida: ${JSON.stringify(action)}`);
    const academic = await loadCurrentAcademicContext(this.dataSource, courseId);
    if (!academic) throw new BadRequestException('NO_ACADEMIC_CONTEXT: el curso no tiene resultados de aprendizaje para vincular.');
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      const [course] = await qr.query(`select structure_version_counter c from public.courses where id = $1 for update`, [courseId]);
      if (Number(course.c) !== expectedCounter) {
        await qr.rollbackTransaction();
        throw new ConflictException({ code: 'STRUCTURE_CHANGED', message: 'STRUCTURE_CHANGED: la estructura cambió; vuelve a verla antes de corregir.' });
      }
      // La misma lista que mostró la verificación (dentro de la transacción: nada cambió desde el contador).
      const plan = await autoLinkPlan(qr, courseId, academic.context);
      let linked = 0;
      const applied: { chapter: string; outcomes: string[] }[] = [];
      for (const s of plan) {
        const res = await qr.query(
          `update public.course_chapters set outcome_ids = $1::jsonb, updated_at = now() where id = $2 and course_id = $3 and (outcome_ids is null or jsonb_array_length(outcome_ids) = 0) returning id`,
          [JSON.stringify(s.suggested), s.chapterId, courseId],
        );
        if (returningRows(res).length) { linked++; applied.push({ chapter: s.title, outcomes: s.suggested }); }
      }
      let counter = expectedCounter;
      if (linked) {
        const n = await qr.query(`update public.courses set structure_version_counter = structure_version_counter + 1 where id = $1 returning structure_version_counter c`, [courseId]);
        counter = Number(returningRows(n)[0].c);
        await advanceStructureOriginIfUntouched(qr, courseId, expectedCounter, counter);
      }
      await qr.commitTransaction();
      return { action, linkedChapters: linked, applied, structureVersionCounter: counter };
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  /** «Liberar»: los valores fijados vuelven a decidirlos Cursia. */
  async clearPins(courseId: number, ownerId: string) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const released = await clearDesignPins(this.dataSource, courseId);
    return { released };
  }

  private async liveChapters(courseId: number): Promise<LiveChapter[]> {
    const rows: { id: string; module_id: string; title: string; objective: string | null; description: string | null; outcome_ids: unknown; kind: string | null }[] = await this.dataSource.query(
      `select id, module_id, title, objective, description, to_jsonb(ch) -> 'outcome_ids' as outcome_ids, to_jsonb(ch) ->> 'chapter_kind' as kind
         from public.course_chapters ch where course_id = $1`,
      [courseId],
    );
    return rows.map((r) => ({ id: r.id, moduleId: r.module_id, title: r.title, objective: r.objective, description: r.description, kind: r.kind === 'practice' ? 'practice' : 'content', outcomeIds: Array.isArray(r.outcome_ids) ? (r.outcome_ids as string[]) : [] }));
  }
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };

/**
 * LOOP 8.4 (review L84 C1/I1/I2) · Lo que la vinculación automática haría: capítulos de CONTENIDO existentes, sin
 * vínculos propios, que el docente no desvinculó a propósito, y para los que hay una sugerencia. Lo usan la verificación
 * (para ofrecer «Corregir» solo si resuelve algo, con vista previa) y la corrección (dentro de su transacción).
 */
export async function autoLinkPlan(q: Q, courseId: number, ctx: AcademicContextV1): Promise<{ chapterId: string; title: string; suggested: string[] }[]> {
  const rows: { id: string; module_id: string; title: string; objective: string | null; description: string | null; outcome_ids: unknown; kind: string | null }[] = await q.query(
    `select id, module_id, title, objective, description, to_jsonb(ch) -> 'outcome_ids' as outcome_ids, to_jsonb(ch) ->> 'chapter_kind' as kind
       from public.course_chapters ch where course_id = $1`,
    [courseId],
  );
  const pins = await loadDesignPins(q, courseId);
  const candidates = rows.filter((r) => r.kind !== 'practice' && !(Array.isArray(r.outcome_ids) && r.outcome_ids.length) && !(pins[r.id] && pins[r.id].noLinks));
  const byId = new Map(candidates.map((r) => [r.id, r]));
  return suggestOutcomeLinks(ctx, candidates.map((r) => ({ id: r.id, moduleId: r.module_id, title: r.title, objective: r.objective, description: r.description, outcomeIds: null })))
    .filter((s) => s.status === 'inferred' && s.suggested.length)
    .map((s) => ({ chapterId: s.chapterId, title: byId.get(s.chapterId)!.title, suggested: s.suggested }));
}

interface LiveChapter { id: string; moduleId: string; title: string; objective: string | null; description: string | null; kind: 'content' | 'practice'; outcomeIds: string[] }

/**
 * Contenidos de las unidades del microcurrículo que ningún capítulo EXISTENTE trabaja (review L84 I5 / L84-2 N2).
 * Un contenido está cubierto si UN capítulo (título + objetivo + descripción, donde la estructura del documento guarda
 * los contenidos) comparte al menos la mitad de sus palabras y, si tiene dos o más, al menos dos. Nunca contra el texto
 * concatenado de un módulo (una palabra suelta como «costo» lo «cubría» todo) ni contra capítulos propuestos.
 */
export function uncoveredUnitContents(ctx: AcademicContextV1, chapters: { title: string; objective?: string | null; description?: string | null }[]): string[] {
  const sets = chapters.map((c) => [...tokenSet([c.title, c.objective || '', c.description || ''].join(' '))]);
  // Review L84-3 Mn4: «clasificación» ≈ «clasificar», «control» ≈ «controlar»: misma raíz de 7 letras (con 6,
  // «información» ≈ «informe» daba por cubierto lo que no lo está).
  const same = (a: string, b: string) => a === b || (a.length >= 7 && b.length >= 7 && a.slice(0, 7) === b.slice(0, 7));
  const out: string[] = [];
  for (const u of ctx.units) {
    for (const c of u.contents) {
      const ct = tokenSet(c.text);
      if (!ct.size) continue;
      const need = ct.size >= 2 ? 2 : 1;
      const hit = sets.some((s) => {
        let inter = 0;
        for (const x of ct) if (s.some((y) => same(x, y))) inter++;
        return inter >= need && inter / ct.size >= LINK_CONTAINMENT_MIN;
      });
      if (!hit) out.push(c.text);
    }
  }
  return out;
}

/**
 * Clasificación de un instrumento del microcurrículo (review L84-3 Mn6 / L84-4): lo que es desempeño sin duda (práctico,
 * proyecto, taller…) pide una Actividad de Aplicación aunque diga «examen» («Examen práctico»); si no, lo que es prueba
 * (parcial, examen, quiz…) pide una evaluación («Examen de casos clínicos»); el resto de desempeño (caso, informe…), una
 * Actividad.
 */
const STRONG_PERFORMANCE_RE = /pr[aá]ctic|proyect|taller|laborator|portafolio|exposici|simulaci|desempe[nñ]o|demostraci/i;
const EXAM_INSTRUMENT_RE = /parcial|examen|prueba|quiz|test\b|cuestionario|evaluaci[oó]n escrita/i;
const PERFORMANCE_INSTRUMENT_RE = /caso|informe|trabajo|ejercicio|estudio de/i;
export function instrumentKind(instrument: string): 'performance' | 'exam' {
  if (STRONG_PERFORMANCE_RE.test(instrument)) return 'performance';
  if (EXAM_INSTRUMENT_RE.test(instrument)) return 'exam';
  return PERFORMANCE_INSTRUMENT_RE.test(instrument) ? 'performance' : 'exam';
}

/**
 * Review L84-2 N6 · Lo que el microcurrículo evalúa y el diseño no: por cada instrumento del documento, sus resultados
 * deben tener evidencia del mismo tipo — desempeño (proyecto, taller, caso…) → una Actividad de Aplicación en un capítulo
 * que trabaje ese resultado; prueba (parcial, examen…) → la evaluación de un módulo que lo trabaje o la evaluación final.
 * Un capítulo propuesto o de práctica trabaja los resultados de su módulo.
 */
export function uncoveredEvaluations(
  ctx: AcademicContextV1,
  dist: { counts: { evaluations: number }; modules: { id: string; examEnabled: boolean; chapters: { id: string; proposed: boolean; kind: string; applicationMinutes?: number | null }[] }[] },
  chapterOutcomes: Map<string, string[]>,
): { instrument: string; outcomes: string[]; kind: 'performance' | 'exam'; chapterIds: string[] }[] {
  const moduleOuts = new Map(dist.modules.map((m) => [m.id, new Set(m.chapters.filter((c) => !c.proposed && c.kind !== 'practice').flatMap((c) => chapterOutcomes.get(c.id) || []))]));
  const outsOf = (m: { id: string }, c: { id: string; proposed: boolean; kind: string }) => (c.proposed || c.kind === 'practice' ? moduleOuts.get(m.id)! : new Set(chapterOutcomes.get(c.id) || []));
  const finalExam = dist.counts.evaluations > dist.modules.filter((m) => m.examEnabled).length;
  const hits = (set: Set<string>, outs: string[]) => !outs.length || outs.some((o) => set.has(o));
  const out: { instrument: string; outcomes: string[]; kind: 'performance' | 'exam'; chapterIds: string[] }[] = [];
  // Capítulos EXISTENTES de contenido que trabajan alguno de esos resultados (donde se activa la Actividad).
  const workingOn = (outs: string[]) => dist.modules.flatMap((m) => m.chapters.filter((c) => !c.proposed && c.kind !== 'practice' && outs.some((o) => (chapterOutcomes.get(c.id) || []).includes(o))).map((c) => c.id));
  for (const ev of ctx.evaluation) {
    if (!ev.instrument) continue;
    const outs = ev.outcomeIds || [];
    if (instrumentKind(ev.instrument) === 'performance') {
      const ok = dist.modules.some((m) => m.chapters.some((c) => (c.applicationMinutes || 0) > 0 && hits(outsOf(m, c), outs)));
      if (!ok) out.push({ instrument: ev.instrument, outcomes: outs, kind: 'performance', chapterIds: workingOn(outs) });
    } else {
      const ok = finalExam || dist.modules.some((m) => m.examEnabled && hits(moduleOuts.get(m.id)!, outs));
      if (!ok) out.push({ instrument: ev.instrument, outcomes: outs, kind: 'exam', chapterIds: [] });
    }
  }
  return out;
}

/** Diseño del distribuidor → lo que necesita la comparación con los requisitos del documento. */
function designForRequirements(
  dist: DistributionResult, targetHours: number | null, hoursSource: DesignForRequirements['hoursSource'],
  structureByTeacher: boolean, audiovisualByTeacher: boolean, applicationByTeacher: boolean,
): DesignForRequirements {
  return {
    modules: dist.modules.map((m) => ({
      examEnabled: m.examEnabled,
      chapters: m.chapters.map((c) => ({
        kind: c.kind, proposed: c.proposed, videoEnabled: c.videoEnabled, videoPinned: c.videoPinned, activityEnabled: c.activityEnabled,
        applicationMinutes: c.applicationMinutes ?? null, applicationPinned: c.applicationPinned, hours: Math.round((c.targetMinutes / 60) * 10) / 10,
      })),
    })),
    evaluations: dist.counts.evaluations,
    targetHours,
    hoursSource,
    structureByTeacher,
    audiovisualByTeacher,
    applicationByTeacher,
  };
}
