import { contentCoverage, contentMapIsStale, documentContents, readContentMap, writeContentMap } from '../academic-context/content-coverage';
import { documentStructureShape, isValidShape, proposeShapedStructureFromContext } from '../academic-context/context-design';
import { recommendShape, shapeDifferences, structuralRequirements } from './structure-options';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CoursesService } from '../courses/courses.service';
import { assertDynamicOwnerAllowed } from '../features/dynamic-features';
import { PedagogyService } from '../pedagogy/pedagogy.service';
import { emptyPedagogicalProfile, normalizePedagogicalProfile } from '../pedagogy/pedagogy-profile';
import { loadCurrentPedagogicalProfile } from '../pedagogy/pedagogy-db';
import { loadCurrentAcademicContext } from '../academic-context/academic-db';
import { documentlessLinkPlanFor, planningOverlay, syncAcademicOutcomesFromProfile } from '../academic-context/profile-outcomes-db';
import { isDocumentlessContext } from '../academic-context/profile-outcomes';
import { loadCourseFacts } from '../course-facts/course-facts-db';
import { isValidTargetHours } from '../study-time/target-hours';
import { defaultApproachRegistry } from '../pedagogy/builtin-approaches';
import { approachFromMethodology } from '../academic-context/context-design';
import { clearDesignPins, loadDesignPins, loadProposedHours, setProposedHours } from './design-pins';
import { ApproachSuggestion, proposeTargetHours, recommendApproachFromFacts } from './design-recommendation';
import { verifyDesign } from './design-verification';
import { returningRows } from '../../common/db/returning-rows';
import { LINK_CONTAINMENT_MIN, suggestOutcomeLinks } from '../academic-context/context-design';
import type { AcademicContextV1 } from '../academic-context/academic-context';
import { tokenSet } from '../coherence/normalize';
import { proposedChapterUuid } from '../pedagogy/dry-run';
import { advanceStructureOriginIfUntouched, readStructureOrigin } from '../course-structure/structure-authority';
import { compareRequirements, DesignForRequirements, RequirementCheck, teacherHoursDeviate } from '../academic-context/requirements/document-requirements';
import {
  DECISION_DEFAULTS, DecisionOverrides, constraintsFor, EXCEPTION_FIELDS, structureEditedByTeacher, EXCEPTION_VALUES, ExceptionField, hoursFromRequirements, loadExceptions, loadRequirementAuthority,
  chosenContentCap, hoursAlternativeOf, requiredContentShape, requirementText, requirementVerificationChecks, teacherDecisions, writeExceptions,
} from '../academic-context/requirements/requirement-authority';
import { DistributionResult } from '../study-time/distributor';
import { ConflictException } from '@nestjs/common';
import { DesignAdjustDto, RecommendDesignDto, RequirementDecisionsDto } from './dto/recommend.dto';
import { COURSE_FORMATS, COURSE_FORMAT_CODES, CourseFormatCode, formatDef, formatFit, readCourseFormat } from '../prebrief/course-formats';
import { randomUUID } from 'crypto';
import { profileOutcomesBlockedBy } from '../academic-context/profile-outcomes-db';
import { BRIEF_KEY, BRIEF_VERSION, normalizeBriefFields, parseBrief } from '../course-facts/course-facts';
import { sortOutcomeIds } from '../academic-context/blueprint-academic';
import {
  AUTOFIX_KEY, AutofixChange, AutofixChapter, AutofixInput, AutofixPlan, AutofixRecord, AutofixState, declinedKeys, inferSector, parseAutofixState, planAutofix,
} from './pedagogical-autofix';

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

  /**
   * Fase 2 · «¿Cómo quieres estructurar tu curso?»: lo que encontró Cursia en el documento, lo que exige, lo que recomienda,
   * los formatos S/M/L y lo elegido. Solo lectura, sin proveedores.
   */
  async structureOptions(courseId: number, ownerId: string) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    const academic = await loadCurrentAcademicContext(this.dataSource, courseId).catch(missingProfilesTable);
    const auth = await loadRequirementAuthority(this.dataSource, courseId, academic ? academic.context.documents : []);
    const facts = await loadCourseFacts(this.dataSource, courseId);
    const docShape = academic ? documentStructureShape(academic.context) : null;
    const contents = academic ? documentContents(academic.context) : [];
    const hours = facts.targetHours && typeof facts.targetHours.value === 'number' ? facts.targetHours.value : null;
    const sreq = structuralRequirements(auth.required);
    const origin = await readStructureOrigin(this.dataSource as any, courseId);
    const fmt = await readCourseFormat(this.dataSource, courseId);
    const live: { n: number }[] = await this.dataSource.query(
      `select count(c.id) filter (where coalesce(to_jsonb(c) ->> 'chapter_kind', 'content') <> 'practice')::int as n
         from public.course_modules m left join public.course_chapters c on c.module_id = m.id where m.course_id = $1 group by m.id, m.position order by m.position`,
      [courseId],
    );
    return {
      providersCalled: 0,
      contextVersion: academic ? academic.version : null,
      hasDocumentContents: contents.length > 0,
      contentsCount: contents.length,
      document: docShape ? { shape: docShape, modules: docShape.length, chapters: docShape.reduce((a, b) => a + b, 0) } : null,
      requirements: {
        modules: sreq.modules.map((r) => requirementText(r)),
        chapters: sreq.chapters.map((r) => requirementText(r)),
        structure: sreq.structure.map((r) => requirementText(r)),
        hours: sreq.hours.map((r) => requirementText(r)),
      },
      targetHours: hours !== null ? { value: hours, source: facts.targetHours.source } : null,
      recommended: recommendShape(auth.required, docShape, hours),
      formats: COURSE_FORMAT_CODES.map((c) => { const f = COURSE_FORMATS[c]; return { code: c, label: f.label, modules: f.modules, chaptersPerModule: f.chaptersPerModule, hoursMin: f.hoursMin, hoursMax: f.hoursMax, targetHours: f.targetHours }; }),
      current: { choice: origin && origin.choice ? origin.choice : null, format: fmt ? fmt.code : null, shape: live.map((r) => Number(r.n)) },
    };
  }

  /**
   * Fase 2/3 · vista previa de una forma: cómo quedan los contenidos del documento (sin aplicar nada), cuántos quedan en
   * capítulos y qué diferencias tiene con lo que establece el documento. Solo lectura, sin proveedores.
   */
  async structurePreview(courseId: number, ownerId: string, shape: { modules: number; chaptersPerModule: number }, formatCode: string | null) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    if (!isValidShape(shape)) throw new BadRequestException('INVALID_SHAPE: la estructura debe tener entre 1 y 50 módulos y entre 1 y 30 capítulos por módulo.');
    const code = formatCode && (COURSE_FORMAT_CODES as readonly string[]).includes(formatCode) ? (formatCode as CourseFormatCode) : null;
    const academic = await loadCurrentAcademicContext(this.dataSource, courseId).catch(missingProfilesTable);
    const auth = await loadRequirementAuthority(this.dataSource, courseId, academic ? academic.context.documents : []);
    const differences = shapeDifferences(auth.required, shape, code);
    const contents = academic ? documentContents(academic.context) : [];
    if (!academic || !contents.length) return { providersCalled: 0, shape, differences, plan: null, coverage: null, notes: [] };
    const p = proposeShapedStructureFromContext(academic.context, shape);
    const assigned = p.modules.flatMap((m) => m.chapters.flatMap((c) => c.sourceContentIds));
    return {
      providersCalled: 0, shape, differences, notes: p.notes,
      plan: p.modules.map((m) => ({ title: m.title, chapters: m.chapters.map((c) => ({ title: c.title, contents: c.sourceContentIds.length, outcomeIds: c.outcomeIds })) })),
      coverage: { total: contents.length, assigned: new Set(assigned).size, duplicated: assigned.length - new Set(assigned).size },
    };
  }

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
    // r63: sin contexto guardado, el que sale de los resultados del perfil pedagógico (vista previa: se guarda al usar el
    // diseño o al preparar el Prebrief). Nunca sobre una propuesta preparada/aprobada (no se invalida sola).
    const eff = await planningOverlay(this.dataSource, courseId, { respectPrebrief: true }).catch((err) => {
      if (err && (err as { code?: string }).code === '42P01') return { academic: null, virtual: false, links: null };
      throw err;
    });
    const academic = eff.academic;
    const academicOverride = eff.virtual ? academic : undefined;
    // Vínculos tal como quedarán al usar el diseño (misma alineación antes y después: la vista previa no miente).
    const chapterLinksOverride = eff.virtual && eff.links ? eff.links : undefined;
    const proposedHours = await loadProposedHours(this.dataSource, courseId);
    const facts = await loadCourseFacts(this.dataSource, courseId, undefined, eff.virtual ? academic : undefined);
    const base: any = saved ? JSON.parse(JSON.stringify(saved.profile)) : emptyPedagogicalProfile();
    delete base.designRules;

    // Enfoque: el guardado manda; sin enfoque (o «recommended» en Ajustar), el que recomienda Cursia.
    const outcomes = academic && academic.context.outcomes.length
      ? academic.context.outcomes.map((o) => o.text)
      : [...((base.learningOutcomes && base.learningOutcomes.know) || []), ...((base.learningOutcomes && base.learningOutcomes.do) || [])];
    const inferred: ApproachSuggestion | null = recommendApproachFromFacts({
      learner: base.learner || null,
      outcomes,
      competencies: academic ? academic.context.competencies.map((c) => c.text) : ((base.learningOutcomes && base.learningOutcomes.competencies) || []),
    });
    // LOOP 9.2 · Autoridad del documento: si su metodología nombra un enfoque (p. ej. «razonamiento sobre casos»), ese es
    // el que recomienda Cursia (antes se deducía solo de los verbos de los resultados y la metodología se ignoraba).
    const meth = academic && academic.context.methodology && academic.context.methodology.status !== 'missing' ? String(academic.context.methodology.value || '') : '';
    const fromDoc = approachFromMethodology(meth);
    const docHint = fromDoc && registry.has(fromDoc.id) ? fromDoc : null;
    const suggestion: ApproachSuggestion | null = docHint
      ? { approach: docHint.id, label: registry.get(docHint.id)!.label, reasons: [`la metodología del documento ${docHint.strong ? 'lo indica' : 'se centra en casos y decisiones'}: «${meth.replace(/\s+/g, ' ').slice(0, 140)}${meth.length > 140 ? '…' : ''}»`], score: inferred && inferred.approach === docHint.id ? inferred.score : 1, confidence: docHint.strong ? 'alta' : 'media' }
      : inferred;
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
    // Loop 9 B (fix I1): «Ejercicios guiados: Automático / Ninguno» (automático = no se guarda nada).
    if (adjust.guidedPractice !== undefined) { if (adjust.guidedPractice === 'auto') delete prefs.guidedPractice; else prefs.guidedPractice = adjust.guidedPractice; }
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
      const probe = await this.pedagogy.dryRunCourse(courseId, ownerId, { profile: normalizePedagogicalProfile({ ...base, targetHours: PROBE_TARGET_HOURS }), requirementDecisions: decisionOverrides, academicOverride, chapterLinksOverride });
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
    let dr = await this.pedagogy.dryRunCourse(courseId, ownerId, { profile, requirementDecisions: decisionOverrides, academicOverride, chapterLinksOverride });
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
          const d2 = await this.pedagogy.dryRunCourse(courseId, ownerId, { profile: p2, requirementDecisions: decisionOverrides, academicOverride, chapterLinksOverride });
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
    const chapterOutcomes = new Map(live.map((r) => [r.id, chapterLinksOverride && chapterLinksOverride.has(r.id) ? chapterLinksOverride.get(r.id)! : r.outcomeIds]));
    const linkDetail = academic && dist ? await autoLinkPlanDetailed(this.dataSource, courseId, academic.context) : null;
    const linkPlan = linkDetail ? linkDetail.plan : [];
    // r71 · «Cursia optimizó tu curso»: lo que corregiría ahora (vista previa, sin escribir) y lo ya corregido.
    const autofix = dist ? await this.autofixPreview(this.dataSource, courseId, academic ? academic.context : null, facts.sector && facts.sector.value ? String(facts.sector.value) : null, chapterLinksOverride) : null;
    const savedComparable = saved ? JSON.stringify(normalizePedagogicalProfile(Object.fromEntries(Object.entries(saved.profile as any).filter(([k]) => k !== 'designRules')))) : null;
    const approachDef = profile.primaryApproach ? registry.get(profile.primaryApproach) : null;
    const providers = dist && dist.materialized ? dist.materialized.providers : null;
    const pinnedChapters = dist ? dist.modules.reduce((n, m) => n + m.chapters.filter((c) => !c.proposed && ((c.videoPinned && c.kind === 'content') || c.applicationPinned || c.guidedPracticePinned)).length, 0) : 0;
    // LOOP 8.6B/8.6C · requisitos del documento frente a ESTE diseño: cumplimiento, excepciones del docente y conflictos.
    let reqChecks: RequirementCheck[] = [];
    let requirementChecks: ReturnType<typeof requirementVerificationChecks> = [];
    if (auth.view.state === 'current' && dist) {
      const origin = await readStructureOrigin(this.dataSource, courseId);
      const [cnt] = await this.dataSource.query(`select structure_version_counter c from public.courses where id = $1`, [courseId]);
      // Review piloto I5: misma regla que las restricciones (la forma de la estructura, no cualquier edición).
      let structureByTeacher = await structureEditedByTeacher(this.dataSource, courseId);
      // Una forma elegida (formato S/M/L o personalizada) IGUAL a la que exige el documento no se aparta de él: un choque de
      // horas con esa forma no es «la estructura que armaste» sino lo que el propio documento fija.
      const docShape = requiredContentShape(auth.required);
      const liveShape = dist.modules.map((m) => m.chapters.filter((c) => !c.proposed && c.kind === 'content').length);
      const shapeIsDocuments = !!docShape && liveShape.length === docShape.length && liveShape.every((n, i) => n === docShape[i]);
      if (shapeIsDocuments) structureByTeacher = false;
      reqChecks = compareRequirements(auth.applicable, designForRequirements(dist, profile.targetHours ?? null, hoursSource === 'requirement' ? 'proposed' : hoursSource,
        structureByTeacher, !!decisions.audiovisual, !!decisions.applicationActivities));
      // Loop 9 (A5): las horas son «del docente» (su excepción, sin chequeo de choque) solo si su meta se APARTA del documento.
      // Una meta escrita en «Ajustar» dentro de lo que pide el documento, con un diseño que no llega, es el mismo choque que
      // con las horas del documento (antes: «Cumple» junto a «24,2 horas (estimadas)»).
      const hoursByTeacher = (hoursSource === 'user' || hoursSource === 'adjusted') && teacherHoursDeviate(auth.applicable, profile.targetHours ?? null);
      const teacherPins = dist.modules.some((m) => m.chapters.some((c) => !c.proposed && (c.videoPinned || c.applicationPinned)));
      // Re-review final L86C: la causa de un choque de horas se averigua, no se adivina — el mismo diseño SIN las decisiones
      // ni lo fijado por el docente. Si el choque persiste, es entre requisitos del documento (crítico), salvo que la
      // estructura del docente se aparte del documento; si desaparece, es la excepción del docente.
      let clashCause: 'teacher' | 'document' | null = null;
      let clashWith: { requirement: (typeof videoReqs)[number]; hours: number } | null = null;
      const clash = dist.status === 'minimum_exceeds_target' || dist.status === 'cannot_reach_target';
      const decided = EXCEPTION_FIELDS.some((f) => !!decisions[f]) || teacherPins;
      const hoursRequired = auth.required.some((r) => r.kind === 'target_hours');
      if (clash && hoursRequired && (decided || structureByTeacher) && !hoursByTeacher) {
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
        // Fase 2/4: con una forma elegida por la institución en «Estructura» (personalizada o formato), Cursia no agrega
        // capítulos de contenido; si las horas no caben en esa forma, es la excepción de la institución (con su motivo).
        const chosenShape = !!(origin && origin.choice && origin.choice !== 'document' && origin.choice !== 'cursia') && !shapeIsDocuments;
        clashCause = !persists || teacherStructureOff || chosenShape ? 'teacher' : 'document';
      }
      requirementChecks = requirementVerificationChecks(auth.applicable, reqChecks, {
        clashCause, structureByTeacher, clashWith,
        status: dist.status, baseHours: dist.baseHours, estimatedHours: dist.estimatedHours, hoursByTeacher,
        teacherPins,
        hoursAlternative: hoursAlternativeOf(dist),
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
    // Prebrief · formato S/M/L elegido: ¿el diseño lo respeta? (advertencia en Verificación si no).
    const fmt = formatDef((await readCourseFormat(this.dataSource, courseId))?.code ?? null);
    // Las horas del formato se comparan con las que el diseño REALMENTE tiene (no con la meta): un diseño de ≈ 22 h no
    // «cumple» un Formato M de 40–44 h aunque la meta sea 42.
    const fmtFit = fmt && dist ? formatFit(fmt, dist.modules.map((m) => ({ chapters: m.chapters.map((c) => ({ kind: c.kind })) })), typeof dist.estimatedHours === 'number' ? dist.estimatedHours : (profile.targetHours ?? null), typeof dist.estimatedHours === 'number' ? Math.max(1, fmt.hoursMax * 0.05) : 0) : null;
    // LOOP 8.4: la verificación del MISMO diseño (alineación del Coherence Engine incluida).
    const verification = dist
      ? verifyDesign({
        growth: await this.designGrowth(courseId, previewConstraints),
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
          ...(linkDetail && linkDetail.review ? { review: linkDetail.review } : {}),
        },
        proposedChapterIds: dist.modules.flatMap((m) => m.chapters.filter((c) => c.proposed).map((c) => proposedChapterUuid(c.id))),
        uncoveredContents: academic ? uncoveredUnitContents(academic.context, live) : [],
        contentCoverage: academic ? contentCoverage(academic.context, academic.version, await readContentMap(this.dataSource, courseId), live.map((c) => c.id)) : null,
        requiredEvaluations: academic ? academic.context.evaluation.map((e) => e.instrument).filter(Boolean) : [],
        pinnedApplicationsOutsideMode: dist.modules.flatMap((m) => m.chapters.filter((c) => c.applicationPinned && c.applicationMinutes
          && ((prefs.applicationActivities || 'auto') === 'none' || ((prefs.applicationActivities || 'auto') === 'practice_only' && c.kind !== 'practice'))).map((c) => c.id)),
        uncoveredEvaluations: academic ? uncoveredEvaluations(academic.context, dist, chapterOutcomes) : [],
        requirementChecks,
        format: fmt && fmtFit ? { label: fmt.label, modules: fmt.modules, chaptersPerModule: fmt.chaptersPerModule, hoursMin: fmt.hoursMin, hoursMax: fmt.hoursMax, ...fmtFit, designHours: dist ? dist.estimatedHours : null } : null,
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
      preferences: { emphasis: prefs.emphasis || 'balanced', applicationActivities: prefs.applicationActivities || 'auto', audiovisual: prefs.audiovisual, guidedPractice: prefs.guidedPractice || 'auto' },
      // Review L83 M-1: solo los fijados que el diseño usa (capítulos de contenido que existen).
      pinnedChapters,
      verification,
      autofix,
      design: dist
        ? {
          status: dist.status,
          estimatedHours: dist.estimatedHours,
          toleranceHours: dist.toleranceHours,
          baseHours: dist.baseHours,
          counts: dist.counts,
          hoursByComponent: dist.hoursByComponent,
          ...(dist.guidedPracticeFill ? { guidedPracticeFill: dist.guidedPracticeFill } : {}),
          // Fix I1: la proporción a la vista («Ejercicios guiados: X h de Y h (Z %)»), para que la institución decida con el número.
          ...(dist.counts.guidedPracticeMinutes ? { guidedPracticeShare: {
            hours: Math.round((dist.counts.guidedPracticeMinutes / 60) * 10) / 10, designHours: dist.estimatedHours,
            pct: Math.round((dist.counts.guidedPracticeMinutes / 60 / Math.max(dist.estimatedHours, 0.1)) * 100) } } : {}),
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
              // Loop 9 B: práctica guiada del capítulo de contenido (formativa, sin nota) y si la fijó el docente.
              guidedPracticeMinutes: c.guidedPracticeMinutes ?? null, guidedPracticePinned: c.guidedPracticePinned,
              outcomeIds: chapterOutcomes.get(c.id) || [],
            })),
          })),
        }
        : null,
      // Prebrief: lo que recomendaría Cursia (aunque el enfoque guardado sea otro), lo que materializa el Manifest y la
      // huella del Blueprint que congelaría hoy la estructura viva.
      suggestedApproach: suggestion ? suggestion.approach : null,
      manifestTotals: dist && dist.materialized ? dist.materialized.totals : null,
      blueprintSha256: dist && dist.materialized ? dist.materialized.blueprintSha256 : null,
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
  /** Qué puede crecer sin contradecir lo fijado (misma regla que la recomendación del distribuidor). */
  private async designGrowth(courseId: number, c: ReturnType<typeof constraintsFor>): Promise<'any' | 'modules' | 'chapters' | 'none'> {
    const cap = await chosenContentCap(this.dataSource, courseId);
    const chFixed = !!c && (c.contentChaptersPerModule?.max !== undefined || c.chaptersPerModule?.max !== undefined);
    const modFixed = !!c && typeof c.modulesFixed === 'number';
    return cap !== null || (chFixed && modFixed) ? 'none' : chFixed ? 'modules' : modFixed ? 'chapters' : 'any';
  }

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
  async fix(courseId: number, ownerId: string, action: string, expectedCounter: number, extra: { changeIds?: string[]; outcomeId?: string; chapterId?: string; field?: string; value?: string } = {}) {
    assertDynamicOwnerAllowed(ownerId);
    await this.loadCourse(courseId, ownerId);
    // r71 · «Cursia optimizó tu curso» y las acciones en línea de la propuesta (paso 5).
    if (action === 'autofix') return this.autofix(courseId, ownerId, expectedCounter);
    if (action === 'autofix_undo') return this.autofixUndo(courseId, expectedCounter, extra.changeIds);
    if (action === 'link_outcome') return this.linkOutcome(courseId, expectedCounter, String(extra.outcomeId || ''), String(extra.chapterId || ''));
    if (action === 'context_field') return this.setContextField(courseId, String(extra.field || ''), extra.value);
    if (action !== 'link_outcomes' && action !== 'cover_contents') throw new BadRequestException(`Acción desconocida: ${JSON.stringify(action)}`);
    if (action === 'cover_contents') return this.coverContents(courseId, expectedCounter, await loadCurrentAcademicContext(this.dataSource, courseId));
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      const [course] = await qr.query(`select structure_version_counter c from public.courses where id = $1 for update`, [courseId]);
      if (Number(course.c) !== expectedCounter) {
        await qr.rollbackTransaction();
        throw new ConflictException({ code: 'STRUCTURE_CHANGED', message: 'STRUCTURE_CHANGED: la estructura cambió; vuelve a verla antes de corregir.' });
      }
      // r63: sin documento, los resultados del perfil pedagógico pasan al contexto académico (idempotente; con documento
      // no cambia nada). Es un pedido explícito («Usar este diseño» / «Vincular ahora»): no espera a otra vista.
      await syncAcademicOutcomesFromProfile(qr, courseId, ownerId, { respectPrebrief: false, link: false, allowRemovals: true });
      const academic = await loadCurrentAcademicContext(qr, courseId);
      if (!academic) {
        await qr.rollbackTransaction();
        throw new BadRequestException('NO_ACADEMIC_CONTEXT: el curso no tiene resultados de aprendizaje para vincular.');
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
      // r63: quitar del contexto un resultado que salió del perfil pudo podar vínculos (y subir el contador): el contador
      // que se devuelve es SIEMPRE el vigente, así la interfaz encadena lo siguiente («Aplicar diseño») sin 409.
      const before = Number((await qr.query(`select structure_version_counter c from public.courses where id = $1`, [courseId]))[0].c);
      let counter = before;
      if (linked) {
        const n = await qr.query(`update public.courses set structure_version_counter = structure_version_counter + 1 where id = $1 returning structure_version_counter c`, [courseId]);
        counter = Number(returningRows(n)[0].c);
        await advanceStructureOriginIfUntouched(qr, courseId, before, counter);
      }
      await qr.commitTransaction();
      return { action, linkedChapters: linked, applied, structureVersionCounter: counter, contextVersion: academic.version };
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  // ── r71 · «Cursia optimizó tu curso» (autocorrección pedagógica) ──────────────────────────────────────────────

  /** Una transacción con el contador de la estructura (el mismo contrato que «Corregir»: 409 si cambió). */
  private async withCounter<T>(courseId: number, expectedCounter: number, fn: (qr: Q, counter: number) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      const [course] = await qr.query(`select structure_version_counter c from public.courses where id = $1 for update`, [courseId]);
      if (Number(course.c) !== expectedCounter) {
        await qr.rollbackTransaction();
        throw new ConflictException({ code: 'STRUCTURE_CHANGED', message: 'STRUCTURE_CHANGED: la estructura cambió; vuelve a verla antes de corregir.' });
      }
      const out = await fn(qr, expectedCounter);
      await qr.commitTransaction();
      return out;
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  private async bumpCounter(q: Q, courseId: number): Promise<number> {
    const before = Number((await q.query(`select structure_version_counter c from public.courses where id = $1`, [courseId]))[0].c);
    const n = await q.query(`update public.courses set structure_version_counter = structure_version_counter + 1 where id = $1 returning structure_version_counter c`, [courseId]);
    const counter = Number(returningRows(n)[0].c);
    await advanceStructureOriginIfUntouched(q as any, courseId, before, counter);
    return counter;
  }

  /** Lo que lee la autocorrección (módulos, capítulos con sus vínculos, desvinculados a propósito, lo deshecho). */
  private async autofixInput(q: Q, courseId: number, ctx: AcademicContextV1 | null, sector: string | null, linksOverride?: Map<string, string[]>): Promise<{ input: AutofixInput; state: AutofixState }> {
    const mods: any[] = await q.query(`select id, position, title, objective, description from public.course_modules where course_id = $1 order by position`, [courseId]);
    const rows: any[] = await q.query(
      `select id, module_id, position, title, objective, description, to_jsonb(ch) -> 'outcome_ids' as outcome_ids, to_jsonb(ch) ->> 'chapter_kind' as kind
         from public.course_chapters ch where course_id = $1`,
      [courseId],
    );
    const pins = await loadDesignPins(q, courseId);
    const state = await loadAutofixState(q, courseId);
    const lexical = ctx ? new Map((await autoLinkPlan(q, courseId, ctx)).map((p) => [p.chapterId, p.suggested])) : new Map<string, string[]>();
    const chapters: AutofixChapter[] = rows.map((r) => ({
      id: r.id, moduleId: r.module_id, position: Number(r.position), title: String(r.title || ''), objective: r.objective, description: r.description,
      kind: r.kind === 'practice' ? 'practice' : 'content',
      outcomeIds: linksOverride && linksOverride.has(r.id) ? [...linksOverride.get(r.id)!] : Array.isArray(r.outcome_ids) ? (r.outcome_ids as string[]) : [],
      ...(pins[r.id] && pins[r.id].noLinks ? { noLinks: true } : {}),
    }));
    // Lo que Cursia aplicó y el docente cambió después por otra vía (editor, «Lo que entendimos»): es decisión suya.
    const declined = declinedKeys(state);
    const byId = new Map(chapters.map((c) => [c.id, c]));
    for (const r of appliedRecords(state)) {
      if (r.kind === 'context_field' && r.target.field === 'sector' && sector !== r.after) declined.add(r.id);
      const ch = r.target.chapterId ? byId.get(r.target.chapterId) : null;
      if (r.target.chapterId && JSON.stringify(ch ? ch.outcomeIds : null) !== JSON.stringify(r.after)) {
        declined.add(r.id); declined.add(`chapter:${r.target.chapterId}`); declined.add(`competency:${r.target.chapterId}`);
      }
    }
    return {
      state,
      input: {
        ctx, chapters, lexical, declined, context: { sector },
        modules: mods.map((m) => ({ id: m.id, position: Number(m.position), title: String(m.title || ''), objective: m.objective, description: m.description })),
        hasDocument: !!ctx && Array.isArray(ctx.documents) && ctx.documents.length > 0,
      },
    };
  }

  /**
   * Vista previa (sin escribir) para «Cursia recomienda» y la propuesta: lo que Cursia corregiría ahora, lo que propone,
   * lo que ya corrigió (con «Deshacer») y las sugerencias para las acciones en línea del paso 5.
   */
  async autofixPreview(q: Q, courseId: number, ctx: AcademicContextV1 | null, sector: string | null, linksOverride?: Map<string, string[]>) {
    const { input, state } = await this.autofixInput(q, courseId, ctx, sector, linksOverride);
    const plan = planAutofix(input);
    // Sugerencias aunque el docente haya deshecho el cambio (la acción en línea es SU decisión).
    const open = planAutofix({ ...input, declined: new Set() });
    const mods = new Map(input.modules.map((m) => [m.id, m.title]));
    return {
      pending: plan.changes.length,
      changes: plan.changes,
      proposals: plan.proposals,
      suggestions: { ...open.suggestions, ...plan.suggestions },
      applied: appliedRecords(state),
      chapters: input.chapters.filter((c) => c.kind === 'content')
        .sort((a, b) => (input.modules.findIndex((m) => m.id === a.moduleId) - input.modules.findIndex((m) => m.id === b.moduleId)) || a.position - b.position)
        .map((c) => ({ id: c.id, title: c.title, moduleTitle: mods.get(c.moduleId) || '' })),
      contextSuggestions: { sector: sector ? null : ((inferSector(ctx) || { value: null }).value as string | null) },
    };
  }

  /** Aplica lo que se deduce con evidencia, de una vez, con su registro (idempotente; nunca pisa al docente). */
  private async autofix(courseId: number, ownerId: string, expectedCounter: number) {
    return this.withCounter(courseId, expectedCounter, async (qr, counter0) => {
      // Una propuesta preparada/aprobada o una producción en curso no se cambian solas (se invalidarían sin pedirlo).
      const blocked = await profileOutcomesBlockedBy(qr, courseId, true);
      if (blocked) return { action: 'autofix' as const, skipped: blocked, applied: [] as AutofixChange[], proposals: [], structureVersionCounter: counter0 };
      await syncAcademicOutcomesFromProfile(qr, courseId, ownerId, { respectPrebrief: false, link: false, allowRemovals: true });
      const academic = await loadCurrentAcademicContext(qr, courseId);
      const facts = await loadCourseFacts(qr, courseId);
      const { input, state } = await this.autofixInput(qr, courseId, academic ? academic.context : null, facts.sector && facts.sector.value ? String(facts.sector.value) : null);
      const plan: AutofixPlan = planAutofix(input);
      const applied: AutofixChange[] = [];
      for (const ch of plan.changes) {
        if (ch.target.chapterId) {
          // Solo si el capítulo sigue como lo vio el plan (nada de otra pestaña se pisa).
          const res = await qr.query(
            `update public.course_chapters set outcome_ids = $1::jsonb, updated_at = now() where id = $2 and course_id = $3 and coalesce(outcome_ids, '[]'::jsonb) = $4::jsonb returning id`,
            [JSON.stringify(ch.after), ch.target.chapterId, courseId, JSON.stringify(ch.before || [])],
          );
          if (returningRows(res).length) applied.push(ch);
        } else if (ch.kind === 'context_field' && ch.target.field) {
          if (await writeBriefField(qr, courseId, ch.target.field, String(ch.after), { inferred: true, onlyIfEmpty: true })) applied.push(ch);
        }
      }
      // r63: la sincronización pudo subir el contador; el que se devuelve es SIEMPRE el vigente.
      let counter = Number((await qr.query(`select structure_version_counter c from public.courses where id = $1`, [courseId]))[0].c);
      if (applied.some((c) => c.target.chapterId)) counter = await this.bumpCounter(qr, courseId);
      const batchId = applied.length ? randomUUID() : null;
      if (applied.length) {
        const at = new Date().toISOString();
        await writeAutofixState(qr, courseId, { ...state, changes: [...state.changes, ...applied.map((c): AutofixRecord => ({ ...c, batchId: batchId!, at, status: 'applied' }))] });
      }
      return { action: 'autofix' as const, batchId, applied, proposals: plan.proposals, suggestions: plan.suggestions, structureVersionCounter: counter };
    });
  }

  /** «Deshacer»: vuelve al valor anterior SOLO si nadie lo cambió después; lo deshecho no se vuelve a aplicar. */
  private async autofixUndo(courseId: number, expectedCounter: number, changeIds?: string[]) {
    return this.withCounter(courseId, expectedCounter, async (qr, counter0) => {
      const state = await loadAutofixState(qr, courseId);
      const want = changeIds && changeIds.length ? new Set(changeIds) : null;
      const targets = appliedRecords(state).filter((r) => !want || want.has(r.id));
      const reverted: string[] = [];
      const changed: string[] = [];
      const now = new Date().toISOString();
      const next: AutofixRecord[] = [];
      for (const r of targets) {
        let ok = false;
        if (r.target.chapterId) {
          const before = Array.isArray(r.before) ? r.before : [];
          const res = await qr.query(
            `update public.course_chapters set outcome_ids = $1::jsonb, updated_at = now() where id = $2 and course_id = $3 and coalesce(outcome_ids, '[]'::jsonb) = $4::jsonb returning id`,
            [before.length ? JSON.stringify(before) : null, r.target.chapterId, courseId, JSON.stringify(r.after)],
          );
          ok = returningRows(res).length > 0;
        } else if (r.kind === 'context_field' && r.target.field) {
          ok = await writeBriefField(qr, courseId, r.target.field, null, { inferred: false, onlyIfValue: String(r.after) });
        }
        (ok ? reverted : changed).push(r.id);
        // Lo que el docente cambió después también queda como decisión suya (Cursia no lo vuelve a tocar).
        next.push({ ...r, status: ok ? 'reverted' : 'superseded', revertedAt: now });
      }
      let counter = counter0;
      if (targets.some((r, i) => r.target.chapterId && next[i].status === 'reverted')) counter = await this.bumpCounter(qr, courseId);
      if (next.length) await writeAutofixState(qr, courseId, { ...state, changes: [...state.changes, ...next] });
      return { action: 'autofix_undo' as const, reverted, changed, structureVersionCounter: counter };
    });
  }

  /** Acción en línea del paso 5: el docente vincula UN resultado (o competencia) a UN capítulo. Solo agrega. */
  private async linkOutcome(courseId: number, expectedCounter: number, outcomeId: string, chapterId: string) {
    return this.withCounter(courseId, expectedCounter, async (qr, counter0) => {
      const academic = await loadCurrentAcademicContext(qr, courseId);
      const known = academic ? [...academic.context.outcomes.map((o) => o.id), ...academic.context.competencies.map((c) => c.id)] : [];
      if (!known.includes(outcomeId)) throw new BadRequestException({ code: 'UNKNOWN_OUTCOME', message: `UNKNOWN_OUTCOME: el curso no tiene el resultado ${JSON.stringify(outcomeId)}.` });
      const [row] = await qr.query(`select to_jsonb(ch) -> 'outcome_ids' as outcome_ids from public.course_chapters ch where id::text = $1 and course_id = $2`, [chapterId, courseId]);
      if (!row) throw new BadRequestException({ code: 'UNKNOWN_CHAPTER', message: 'UNKNOWN_CHAPTER: el capítulo no es de este curso.' });
      const cur: string[] = Array.isArray(row.outcome_ids) ? row.outcome_ids : [];
      if (cur.includes(outcomeId)) return { action: 'link_outcome' as const, linked: false, chapterId, outcomeIds: cur, structureVersionCounter: counter0 };
      const next = sortOutcomeIds([...cur, outcomeId]);
      await qr.query(`update public.course_chapters set outcome_ids = $1::jsonb, updated_at = now() where id = $2 and course_id = $3`, [JSON.stringify(next), chapterId, courseId]);
      const counter = await this.bumpCounter(qr, courseId);
      return { action: 'link_outcome' as const, linked: true, chapterId, outcomeIds: next, structureVersionCounter: counter };
    });
  }

  /** Acción en línea del paso 5: el docente completa un dato del curso que falta (queda como dato suyo, no inferido). */
  private async setContextField(courseId: number, field: string, value: string | undefined) {
    if (!['sector', 'pais', 'ciudad', 'tono'].includes(field)) throw new BadRequestException(`Dato desconocido: ${JSON.stringify(field)}`);
    const v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!v || v.length > 255) throw new BadRequestException('value: escribe el dato (hasta 255 caracteres).');
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      await qr.query(`select id from public.courses where id = $1 for update`, [courseId]);
      await writeBriefField(qr, courseId, field, v, { inferred: false });
      // Si Cursia lo había inferido, el valor del docente lo reemplaza: ese cambio deja de poder deshacerse.
      const state = await loadAutofixState(qr, courseId);
      const sup = appliedRecords(state).filter((r) => r.kind === 'context_field' && r.target.field === field);
      if (sup.length) await writeAutofixState(qr, courseId, { ...state, changes: [...state.changes, ...sup.map((r): AutofixRecord => ({ ...r, status: 'superseded', revertedAt: new Date().toISOString() }))] });
      await qr.commitTransaction();
      return { action: 'context_field' as const, field, value: v };
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

  /**
   * Fase 3 · «Incluirlos en un capítulo»: cada contenido del documento que quedó sin capítulo va al capítulo de su vecino
   * en el orden del documento (el anterior cubierto; si no hay, el siguiente; si no, el primer capítulo de contenido). Se
   * agrega a su descripción y a la trazabilidad. Nunca borra ni mueve nada.
   */
  private async coverContents(courseId: number, expectedCounter: number, academic: Awaited<ReturnType<typeof loadCurrentAcademicContext>>) {
    if (!academic) throw new BadRequestException('NO_ACADEMIC_CONTEXT: el curso no tiene un documento con contenidos.');
    const qr = this.dataSource.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      const [course] = await qr.query(`select structure_version_counter c from public.courses where id = $1 for update`, [courseId]);
      if (Number(course.c) !== expectedCounter) {
        await qr.rollbackTransaction();
        throw new ConflictException({ code: 'STRUCTURE_CHANGED', message: 'STRUCTURE_CHANGED: la estructura cambió; vuelve a verla antes de corregir.' });
      }
      const map = await readContentMap(qr, courseId);
      if (!map || contentMapIsStale(academic.context, map)) {
        await qr.rollbackTransaction();
        throw new BadRequestException({ code: 'NO_CONTENT_MAP', message: 'NO_CONTENT_MAP: la estructura no se armó con esta versión del documento; vuelve a elegirla en «Estructura».' });
      }
      const chs: { id: string; position: number; mpos: number; description: string | null; kind: string | null }[] = await qr.query(
        `select c.id, c.position, m.position as mpos, c.description, to_jsonb(c) ->> 'chapter_kind' as kind
           from public.course_chapters c join public.course_modules m on m.id = c.module_id where c.course_id = $1 order by m.position, c.position`,
        [courseId],
      );
      const live = new Set(chs.map((c) => c.id));
      const contents = documentContents(academic.context);
      const chapterOf = new Map<string, string>();
      for (const [cid, ids] of Object.entries(map.chapters)) if (live.has(cid)) for (const id of ids) if (!chapterOf.has(id)) chapterOf.set(id, cid);
      const firstContent = chs.find((c) => c.kind !== 'practice');
      const applied: { content: string; chapterId: string }[] = [];
      contents.forEach((c, i) => {
        if (chapterOf.has(c.id)) return;
        let target: string | undefined;
        for (let j = i - 1; j >= 0 && !target; j--) target = chapterOf.get(contents[j].id);
        for (let j = i + 1; j < contents.length && !target; j++) target = chapterOf.get(contents[j].id);
        target = target || (firstContent && firstContent.id);
        if (!target) throw new ConflictException({ code: 'NO_TARGET_CHAPTER', message: 'NO_TARGET_CHAPTER: el curso no tiene un capítulo de contenido donde incluir los contenidos; agrega uno en «Editar estructura».' });
        chapterOf.set(c.id, target);
        map.chapters[target] = [...(map.chapters[target] || []), c.id];
        applied.push({ content: c.text, chapterId: target });
      });
      for (const a of applied) {
        const ch = chs.find((c) => c.id === a.chapterId)!;
        const desc = [ch.description, a.content].filter(Boolean).join('; ');
        ch.description = desc.length > 2000 ? `${desc.slice(0, 1999)}…` : desc;
        await qr.query(`update public.course_chapters set description = $1, updated_at = now() where id = $2 and course_id = $3`, [ch.description, a.chapterId, courseId]);
      }
      let counter = expectedCounter;
      if (applied.length) {
        await writeContentMap(qr, courseId, { ...map, at: new Date().toISOString() });
        const n = await qr.query(`update public.courses set structure_version_counter = structure_version_counter + 1 where id = $1 returning structure_version_counter c`, [courseId]);
        counter = Number(returningRows(n)[0].c);
        await advanceStructureOriginIfUntouched(qr, courseId, expectedCounter, counter);
      }
      await qr.commitTransaction();
      return { action: 'cover_contents', coveredContents: applied.length, applied: applied.map((a) => a.content), structureVersionCounter: counter };
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
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
  return (await autoLinkPlanDetailed(q, courseId, ctx)).plan;
}

/**
 * r63 · Lo mismo que autoLinkPlan y, sin documento, lo que NO se puede vincular con confianza («requiere revisión»):
 * resultados sin un capítulo que les encaje y capítulos de contenido sin un resultado que les encaje. Nunca se fuerza.
 */
export async function autoLinkPlanDetailed(q: Q, courseId: number, ctx: AcademicContextV1): Promise<{
  plan: { chapterId: string; title: string; suggested: string[] }[];
  review: { outcomes: { id: string; text: string }[]; chapters: { chapterId: string; title: string }[]; partial: { chapterId: string; title: string; outcomeIds: string[]; linked: boolean }[] } | null;
}> {
  if (isDocumentlessContext(ctx)) {
    const { plan, titles } = await documentlessLinkPlanFor(q, courseId, ctx);
    return {
      plan: plan.links.map((l) => ({ chapterId: l.chapterId, title: titles.get(l.chapterId) || '', suggested: l.suggested })),
      review: {
        outcomes: plan.ambiguous.map((a) => ({ id: a.id, text: a.text })),
        chapters: plan.unmatchedChapterIds.map((id) => ({ chapterId: id, title: titles.get(id) || '' })),
        partial: plan.partial.map((p) => ({ chapterId: p.chapterId, title: titles.get(p.chapterId) || '', outcomeIds: p.outcomeIds, linked: p.linked })),
      },
    };
  }
  return { plan: await documentAutoLinkPlan(q, courseId, ctx), review: null };
}

async function documentAutoLinkPlan(q: Q, courseId: number, ctx: AcademicContextV1): Promise<{ chapterId: string; title: string; suggested: string[] }[]> {
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
      ...(m.practiceRemovedByTeacher ? { practiceRemovedByTeacher: true } : {}),
      chapters: m.chapters.map((c) => ({
        kind: c.kind, proposed: c.proposed, videoEnabled: c.videoEnabled, videoPinned: c.videoPinned, activityEnabled: c.activityEnabled, activityPinned: !!c.activityPinned,
        applicationMinutes: c.applicationMinutes ?? null, applicationPinned: c.applicationPinned, hours: Math.round((c.targetMinutes / 60) * 10) / 10,
        guidedPracticeMinutes: c.guidedPracticeMinutes ?? null,
      })),
    })),
    evaluations: dist.counts.evaluations,
    targetHours,
    estimatedHours: dist.estimatedHours,
    hoursStatus: dist.status,
    hoursSource,
    structureByTeacher,
    audiovisualByTeacher,
    applicationByTeacher,
  };
}

/** Solo una base sin las tablas de perfiles (entornos viejos) cuenta como «sin documento»; cualquier otro error se propaga. */
function missingProfilesTable(err: any): null {
  if (err && err.code === '42P01') return null;
  throw err;
}

// ── r71 · registro de la autocorrección y escritura de un dato del pedido ─────────────────────────────────────────

const AUTOFIX_MAX_RECORDS = 600;

export async function loadAutofixState(q: Q, courseId: number): Promise<AutofixState> {
  const [row] = await q.query(`select metadata -> '${AUTOFIX_KEY}' as s from public.courses where id = $1`, [courseId]);
  const v = row ? (typeof row.s === 'string' ? JSON.parse(row.s) : row.s) : null;
  return parseAutofixState(v);
}

async function writeAutofixState(q: Q, courseId: number, state: AutofixState): Promise<void> {
  const changes = state.changes.slice(-AUTOFIX_MAX_RECORDS);
  await q.query(
    `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[], $3::jsonb, true) where id = $1`,
    [courseId, [AUTOFIX_KEY], JSON.stringify({ autofixVersion: state.autofixVersion, changes })],
  );
}

/** Lo que sigue aplicado (el último registro de cada cambio es «aplicado»), en el orden en que se aplicó. */
export function appliedRecords(state: AutofixState): AutofixRecord[] {
  const last = new Map<string, AutofixRecord>();
  for (const c of state.changes) { last.delete(c.id); last.set(c.id, c); }
  return [...last.values()].filter((c) => c.status === 'applied');
}

/**
 * Un dato del pedido del curso (courses.metadata.brief). `inferred` lo marca como inferido por Cursia («inferidos»);
 * `onlyIfEmpty` no pisa un valor existente; `onlyIfValue` solo lo cambia si todavía tiene ese valor (deshacer). value null = quitarlo.
 */
async function writeBriefField(q: Q, courseId: number, field: string, value: string | null, opts: { inferred: boolean; onlyIfEmpty?: boolean; onlyIfValue?: string }): Promise<boolean> {
  const [row] = await q.query(`select metadata -> '${BRIEF_KEY}' as b from public.courses where id = $1`, [courseId]);
  const prev = parseBrief(row ? (typeof row.b === 'string' ? JSON.parse(row.b) : row.b) : null);
  const fields: Record<string, string> = { ...((prev ? prev.fields : {}) as Record<string, string>) };
  if (opts.onlyIfEmpty && fields[field]) return false;
  if (opts.onlyIfValue !== undefined && fields[field] !== opts.onlyIfValue) return false;
  const inferred = new Set(String(fields.inferidos || '').split(',').map((x) => x.trim()).filter(Boolean));
  if (value) fields[field] = value; else delete fields[field];
  if (opts.inferred && value) inferred.add(field); else inferred.delete(field);
  if (inferred.size) fields.inferidos = [...inferred].join(','); else delete fields.inferidos;
  const brief = { briefVersion: BRIEF_VERSION, fields: normalizeBriefFields(fields), updatedAt: new Date().toISOString() };
  await q.query(
    `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), $2::text[], $3::jsonb, true) where id = $1`,
    [courseId, [BRIEF_KEY], JSON.stringify(brief)],
  );
  return true;
}
