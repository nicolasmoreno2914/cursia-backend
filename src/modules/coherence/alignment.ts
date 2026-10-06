import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import type { GenerationManifestV1, ManifestItem } from '../generation-manifests/generation-manifest-builder';
import { itemOutcomeIds } from '../academic-context/alignment-brief';
import type { AcademicBlueprintContext } from '../academic-context/blueprint-academic';
import { isPerformanceLevel } from '../academic-context/bloom';
import type { PedagogicalApproachRegistry } from '../pedagogy/approach-registry';
import { defaultApproachRegistry } from '../pedagogy/builtin-approaches';
import { PEDAGOGICAL_DIMENSIONS, PedagogicalDimension } from '../pedagogy/vocabulary';
import type { StudyTimeEstimate } from '../study-time/time-model';
import { sha256Canonical } from './canonical-json';

/**
 * Fase 4 — Coherence Engine, capa A (alineación). Spec: docs/superpowers/specs/2026-10-06-coherence-alignment-design.md.
 *
 * ¿El curso que se diseña está alineado con lo que debe enseñar? Para cada resultado de aprendizaje / competencia del
 * contexto académico CONGELADO en el Blueprint v2, el mapa lista sus EVIDENCIAS tipadas (instrucción, práctica,
 * aplicación, evaluación) con su item del Manifest y sus minutos — nunca «texto relacionado» —, y las reglas A1–A7 /
 * P1–P3 detectan vacíos con severidad crítico / advertencia / sugerencia.
 *
 * El enfoque pedagógico cambia lo que se exige SIN reglas por nombre de enfoque: las dimensiones del registro de
 * enfoques (práctica, evidencia, problema primero, reflexión, conocimientos previos, autorregulación) fijan umbrales y
 * severidades. Sin contexto académico no hay reporte (`available: false`): los cursos de siempre no cambian.
 *
 * Puro y determinista: mismo Blueprint + Manifest + tiempos ⇒ mismo reporte (y mismo sha). No toca nada ni llama a
 * ningún proveedor.
 */

export const ALIGNMENT_VERSION = 1 as const;
export const ALIGNMENT_RULESET = 'alignment-rules@1' as const;

export type AlignmentSeverity = 'critical' | 'warning' | 'suggestion';
export type EvidenceKind = 'instruction' | 'practice' | 'application' | 'assessment';

export interface AlignmentEvidence {
  kind: EvidenceKind;
  itemKey: string;
  type: string;
  moduleId: string | null;
  chapterId: string | null;
  /**
   * Minutos del recurso. Una tarea que integra varios resultados los practica a todos durante todo su tiempo: cada
   * resultado cuenta los minutos completos (es la práctica DISPONIBLE para el resultado, no un reparto del curso).
   */
  minutes: number;
  /** Solo evaluaciones: estilo del examen según el diseño pedagógico ('standard' sin diseño). */
  style?: string;
}

export interface OutcomeAlignment {
  id: string;
  text: string;
  level: string | null;
  domain: 'know' | 'do' | 'competency';
  /** Pide desempeño (aplicar o superior) o es competencia. */
  performance: boolean;
  /** Alta complejidad: analizar / evaluar / crear, o competencia. */
  complex: boolean;
  chapterIds: string[];
  evidence: AlignmentEvidence[];
  minutes: { instruction: number; practice: number; application: number; assessmentItems: number };
  status: 'covered' | 'partial' | 'uncovered';
}

export interface AlignmentFinding {
  id: string;
  rule: string;
  severity: AlignmentSeverity;
  outcomeIds: string[];
  moduleIds: string[];
  chapterIds: string[];
  message: string;
  suggestion: string;
  evidence: Record<string, unknown>;
}

export interface AlignmentChapterRow {
  chapterId: string;
  moduleId: string;
  title: string;
  kind: 'content' | 'practice';
  /** Vínculos propios del capítulo (Blueprint). */
  outcomeIds: string[];
  /** Lo que evidencia (la práctica sin vínculos integra los de su módulo). */
  effectiveOutcomeIds: string[];
}

export interface AlignmentReport {
  alignmentVersion: typeof ALIGNMENT_VERSION;
  ruleset: typeof ALIGNMENT_RULESET;
  available: true;
  blueprintSha256: string | null;
  approach: { approaches: { id: string; weight: number }[]; dimensions: Record<PedagogicalDimension, number> };
  thresholds: { practiceMinutesForComplex: number; missingPracticeIsCritical: boolean; problemChecks: boolean; priorKnowledgeChecks: boolean; reflectionChecks: boolean };
  outcomes: OutcomeAlignment[];
  chapters: AlignmentChapterRow[];
  findings: AlignmentFinding[];
  counts: { critical: number; warning: number; suggestion: number };
  coverage: { outcomes: number; covered: number; partial: number; uncovered: number };
  reportSha256: string;
}

export interface AlignmentUnavailable {
  alignmentVersion: typeof ALIGNMENT_VERSION;
  ruleset: typeof ALIGNMENT_RULESET;
  available: false;
  reason: 'NO_ACADEMIC_CONTEXT';
}

export interface AlignmentInput {
  snapshot: BlueprintSnapshotV2;
  manifest: GenerationManifestV1;
  studyTime: StudyTimeEstimate;
  blueprintSha256?: string | null;
  /** ¿El contexto académico declara conocimientos previos? (P2). null = desconocido. */
  priorKnowledgeDeclared?: boolean | null;
  registry?: PedagogicalApproachRegistry;
}

/** Umbrales derivados de las dimensiones del enfoque (el mismo motor pedagógico, sin reglas por nombre). */
export const ALIGNMENT_THRESHOLDS = Object.freeze({
  /** Minutos de práctica + aplicación de un resultado complejo: 30 + 90 × práctica (redondeado a 5). */
  practiceBase: 30,
  practicePerDimension: 90,
  /** evidence ≥ esto ⇒ un resultado de desempeño sin práctica es CRÍTICO. */
  evidenceCritical: 0.85,
  /** Dimensiones que encienden las sugerencias P1–P3. */
  problemFirst: 0.7,
  priorKnowledge: 0.7,
  reflection: 0.7,
});

const CONCEPTUAL_EXAM_STYLES = new Set(['conceptual_relations', 'self_check_bank', 'integrative_concept_synthesis', 'self_assessment_plus_test']);
const NEUTRAL = 0.5;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round5 = (n: number) => Math.round(n / 5) * 5;

/** Dimensiones del diseño congelado: mezcla ponderada de los enfoques (sin enfoque: 0,5 en todas). */
export function alignmentDimensions(snapshot: BlueprintSnapshotV2, registry: PedagogicalApproachRegistry = defaultApproachRegistry()): AlignmentReport['approach'] {
  const ped = snapshot.course.pedagogy;
  const dims = Object.fromEntries(PEDAGOGICAL_DIMENSIONS.map((d) => [d, NEUTRAL])) as Record<PedagogicalDimension, number>;
  if (!ped || !ped.approaches.length) return { approaches: [], dimensions: dims };
  const known = ped.approaches.filter((a) => registry.has(a.id));
  const total = known.reduce((s, a) => s + a.weight, 0);
  if (!known.length || total <= 0) return { approaches: [], dimensions: dims };
  for (const d of PEDAGOGICAL_DIMENSIONS) {
    dims[d] = round2(known.reduce((s, a) => s + (a.weight / total) * registry.get(a.id).dimensions[d], 0));
  }
  return { approaches: known.map((a) => ({ id: a.id, weight: a.weight })), dimensions: dims };
}

function evidenceKindOf(it: ManifestItem, practiceChapters: Set<string>): EvidenceKind | null {
  switch (it.type) {
    case 'content':
      return 'instruction';
    case 'experience':
      return it.chapterId && practiceChapters.has(it.chapterId) ? 'practice' : 'instruction';
    case 'activity':
    case 'video_interactions':
      return 'practice';
    case 'application_activity':
      return 'application';
    case 'exam':
    case 'final_exam':
      return 'assessment';
    default:
      return null;
  }
}

/** Minutos de cada item a partir del modelo de tiempo (por recurso del capítulo / módulo / curso). */
function itemMinutes(st: StudyTimeEstimate): Map<string, number> {
  const out = new Map<string, number>();
  const add = (k: string, m: number) => out.set(k, round2((out.get(k) ?? 0) + m));
  for (const m of st.modules) {
    for (const r of m.resources) if (r.resource === 'module_exam') add(`exam:${m.moduleId}`, r.minutes);
    for (const c of m.chapters) {
      for (const r of c.resources) {
        if (r.resource === 'activity') add(`activity:${c.chapterId}`, r.minutes);
        else if (r.resource === 'video_interactions') add(`video_interactions:${c.chapterId}`, r.minutes);
        else if (r.resource === 'application_activity') add(`application_activity:${c.chapterId}`, r.minutes);
        else if (r.resource === 'practice_page') add(`experience:${c.chapterId}`, r.minutes);
        else if (r.resource === 'chapter_page' || r.resource === 'libro' || r.resource === 'presentation' || r.resource === 'video') add(`content:${c.chapterId}`, r.minutes);
      }
    }
  }
  for (const r of st.resources) if (r.resource === 'final_exam') out.set('final_exam', round2(r.minutes));
  return out;
}

function short(s: string): string {
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}

export function buildAlignmentReport(input: AlignmentInput): AlignmentReport | AlignmentUnavailable {
  const { snapshot, manifest, studyTime } = input;
  const ctx: AcademicBlueprintContext | undefined = snapshot.course.academicContext;
  if (!ctx) return { alignmentVersion: ALIGNMENT_VERSION, ruleset: ALIGNMENT_RULESET, available: false, reason: 'NO_ACADEMIC_CONTEXT' };
  const registry = input.registry ?? defaultApproachRegistry();
  const approach = alignmentDimensions(snapshot, registry);
  const D = approach.dimensions;
  const T = ALIGNMENT_THRESHOLDS;
  const thresholds = {
    practiceMinutesForComplex: round5(T.practiceBase + T.practicePerDimension * D.practice),
    missingPracticeIsCritical: D.evidence >= T.evidenceCritical,
    problemChecks: D.problemFirst >= T.problemFirst,
    priorKnowledgeChecks: D.priorKnowledge >= T.priorKnowledge,
    reflectionChecks: D.reflection >= T.reflection || D.selfRegulation >= T.reflection,
  };
  const ped = snapshot.course.pedagogy;
  const examStyle = ped ? ped.assessment.examStyle : 'standard';
  const finalExamStyle = ped ? ped.assessment.finalExamStyle : 'standard';

  // Capítulos (orden del curso) y vínculos efectivos.
  const modules = [...snapshot.modules].sort((a, b) => a.position - b.position);
  const practiceChapters = new Set<string>();
  const chapterRows: AlignmentChapterRow[] = [];
  for (const m of modules) {
    for (const c of [...m.chapters].sort((a, b) => a.position - b.position)) {
      const kind = c.kind === 'practice' ? 'practice' : 'content';
      if (kind === 'practice') practiceChapters.add(c.id);
      chapterRows.push({
        chapterId: c.id, moduleId: m.id, title: c.title, kind,
        outcomeIds: [...(c.outcomeIds ?? [])],
        effectiveOutcomeIds: itemOutcomeIds(snapshot, { type: 'content', moduleId: m.id, chapterId: c.id }),
      });
    }
  }
  // Para la práctica, itemOutcomeIds con type 'content' devuelve lo del módulo; para un content sin vínculos, [].
  const minutesOf = itemMinutes(studyTime);

  const outcomes = new Map<string, OutcomeAlignment>();
  for (const o of ctx.outcomes) {
    const performance = isPerformanceLevel(o.level as any);
    outcomes.set(o.id, { id: o.id, text: o.text, level: o.level, domain: o.domain, performance, complex: o.level === 'analyze' || o.level === 'evaluate' || o.level === 'create', chapterIds: [], evidence: [], minutes: { instruction: 0, practice: 0, application: 0, assessmentItems: 0 }, status: 'uncovered' });
  }
  for (const c of ctx.competencies) {
    outcomes.set(c.id, { id: c.id, text: c.text, level: null, domain: 'competency', performance: true, complex: true, chapterIds: [], evidence: [], minutes: { instruction: 0, practice: 0, application: 0, assessmentItems: 0 }, status: 'uncovered' });
  }

  for (const it of manifest.items) {
    const kind = evidenceKindOf(it, practiceChapters);
    if (!kind) continue;
    const ids = itemOutcomeIds(snapshot, { type: it.type, moduleId: it.moduleId, chapterId: it.chapterId }).filter((id) => outcomes.has(id));
    if (!ids.length) continue;
    const share = it.type === 'final_exam' ? (minutesOf.get('final_exam') ?? 0) : (minutesOf.get(it.key) ?? 0);
    for (const id of ids) {
      const o = outcomes.get(id)!;
      const ev: AlignmentEvidence = { kind, itemKey: it.key, type: it.type, moduleId: it.moduleId, chapterId: it.chapterId, minutes: share };
      if (kind === 'assessment') ev.style = it.type === 'final_exam' ? finalExamStyle : examStyle;
      o.evidence.push(ev);
      if (kind === 'instruction') o.minutes.instruction = round2(o.minutes.instruction + share);
      else if (kind === 'practice') o.minutes.practice = round2(o.minutes.practice + share);
      else if (kind === 'application') o.minutes.application = round2(o.minutes.application + share);
      else o.minutes.assessmentItems += 1;
      if (it.chapterId && (kind === 'instruction' || kind === 'practice' || kind === 'application') && !o.chapterIds.includes(it.chapterId)) o.chapterIds.push(it.chapterId);
    }
  }

  // ── Reglas ──
  const findings: Omit<AlignmentFinding, 'id'>[] = [];
  const add = (f: Omit<AlignmentFinding, 'id'>) => findings.push(f);
  for (const o of outcomes.values()) {
    const has = (k: EvidenceKind) => o.evidence.some((e) => e.kind === k);
    const label = o.domain === 'competency' ? 'La competencia' : 'El resultado';
    const f = o.domain === 'competency'; // concordancia: «cubierta» / «cubierto»
    const practiceMin = round2(o.minutes.practice + o.minutes.application);
    const moduleIds = [...new Set(o.evidence.map((e) => e.moduleId).filter((x): x is string => !!x))].sort();
    if (!has('instruction') && !has('practice') && !has('application')) {
      add({ rule: 'A1', severity: 'critical', outcomeIds: [o.id], moduleIds: [], chapterIds: [], message: `${label} ${o.id} («${short(o.text)}») no está ${f ? 'cubierta' : 'cubierto'} por ningún capítulo.`, suggestion: 'Vincúlalo a los capítulos que lo trabajan o agrega un capítulo que lo desarrolle.', evidence: { outcomeId: o.id } });
    } else {
      if (!has('assessment') && !has('application')) {
        add({ rule: 'A2', severity: 'warning', outcomeIds: [o.id], moduleIds, chapterIds: o.chapterIds, message: `${label} ${o.id} no tiene ninguna evaluación que ${f ? 'la' : 'lo'} verifique.`, suggestion: 'Activa el examen del módulo donde se trabaja o agrega una Actividad de Aplicación con criterios.', evidence: { outcomeId: o.id } });
      }
      if (o.performance && !has('practice') && !has('application')) {
        add({
          rule: 'A3', severity: thresholds.missingPracticeIsCritical ? 'critical' : 'warning', outcomeIds: [o.id], moduleIds, chapterIds: o.chapterIds,
          message: `${label} ${o.id} no tiene suficiente evidencia práctica.`,
          suggestion: 'Activa la actividad de sus capítulos o agrega una Actividad de Aplicación o un capítulo de práctica en su módulo.',
          evidence: { outcomeId: o.id, level: o.level, evidenceDimension: D.evidence },
        });
      }
      const assessments = o.evidence.filter((e) => e.kind === 'assessment');
      if (o.performance && assessments.length && !has('application') && assessments.every((e) => CONCEPTUAL_EXAM_STYLES.has(e.style ?? ''))) {
        add({
          rule: 'A5', severity: 'warning', outcomeIds: [o.id], moduleIds, chapterIds: o.chapterIds,
          message: `${label} ${o.id} requiere aplicación, pero su evaluación es solo conceptual.`,
          suggestion: 'Agrega una Actividad de Aplicación en un capítulo del resultado, o usa un enfoque cuyo examen trabaje casos o problemas.',
          evidence: { outcomeId: o.id, examStyles: [...new Set(assessments.map((e) => e.style))].sort() },
        });
      }
      if (o.complex && (has('practice') || has('application')) && practiceMin < thresholds.practiceMinutesForComplex) {
        add({
          rule: 'A6', severity: 'warning', outcomeIds: [o.id], moduleIds, chapterIds: o.chapterIds,
          message: `${label} ${o.id} tiene alta complejidad pero solo dispone de ${Math.round(practiceMin)} minutos de práctica.`,
          suggestion: `Para este enfoque conviene al menos ${thresholds.practiceMinutesForComplex} minutos: sube el nivel de su Actividad de Aplicación o agrega práctica en su módulo.`,
          evidence: { outcomeId: o.id, practiceMinutes: practiceMin, requiredMinutes: thresholds.practiceMinutesForComplex },
        });
      }
    }
    if (o.domain !== 'competency' && o.level === null) {
      add({ rule: 'A7', severity: 'suggestion', outcomeIds: [o.id], moduleIds: [], chapterIds: [], message: `${label} ${o.id} no empieza con un verbo observable reconocido.`, suggestion: 'Redáctalo con un verbo observable (identificar, aplicar, analizar, diseñar…) para saber qué evidencia pide.', evidence: { outcomeId: o.id } });
    }
  }
  for (const ch of chapterRows) {
    if (ch.kind === 'content' && !ch.outcomeIds.length) {
      add({ rule: 'A4', severity: 'warning', outcomeIds: [], moduleIds: [ch.moduleId], chapterIds: [ch.chapterId], message: `El capítulo «${short(ch.title)}» no está claramente asociado a ningún resultado.`, suggestion: 'Vincúlalo a los resultados que trabaja o revisa si sobra.', evidence: { chapterId: ch.chapterId } });
    }
  }
  // Sugerencias del enfoque (dimensiones del motor pedagógico).
  for (const m of modules) {
    const items = manifest.items.filter((i) => i.moduleId === m.id);
    const hasApplication = items.some((i) => i.type === 'application_activity');
    if (thresholds.problemChecks) {
      const decision = items.some((i) => i.type === 'activity' && (i.h5pType === 'branchingscenario' || i.variant === 'scorm')) || hasApplication ||
        // La intención de decidir del diseño solo cuenta donde la actividad del capítulo existe.
        m.chapters.some((c) => c.activityEnabled && !!c.design && (c.design.activity.intent === 'decide' || c.design.scenario.branching));
      if (!decision) add({ rule: 'P1', severity: 'suggestion', outcomeIds: [], moduleIds: [m.id], chapterIds: [], message: `El módulo «${short(m.title)}» no tiene un problema para analizar y decidir.`, suggestion: 'Con este enfoque, cada módulo debería cerrar con un caso o escenario de decisión (Actividad de Aplicación o escenario ramificado).', evidence: { moduleId: m.id, problemFirst: D.problemFirst } });
    }
    if (thresholds.reflectionChecks && !hasApplication && !(m.design && /reflection|self_assessment/.test(m.design.closing))) {
      add({ rule: 'P3', severity: 'suggestion', outcomeIds: [], moduleIds: [m.id], chapterIds: [], message: `El módulo «${short(m.title)}» no tiene autoevaluación ni reflexión.`, suggestion: 'Agrega una Actividad de Aplicación (trae autoevaluación) o un cierre reflexivo.', evidence: { moduleId: m.id, reflection: D.reflection, selfRegulation: D.selfRegulation } });
    }
  }
  if (thresholds.priorKnowledgeChecks && input.priorKnowledgeDeclared === false) {
    add({ rule: 'P2', severity: 'suggestion', outcomeIds: [], moduleIds: [], chapterIds: [], message: 'El contexto no declara los conocimientos previos del estudiante.', suggestion: 'Con este enfoque conviene registrarlos: la apertura de cada módulo se apoya en ellos.', evidence: { priorKnowledge: D.priorKnowledge } });
  }

  // Estado por resultado.
  for (const o of outcomes.values()) {
    const has = (k: EvidenceKind) => o.evidence.some((e) => e.kind === k);
    const taught = has('instruction') || has('practice') || has('application');
    const practiced = !o.performance || has('practice') || has('application');
    const assessed = has('assessment') || has('application');
    o.status = !taught ? 'uncovered' : practiced && assessed && !findings.some((f) => f.outcomeIds.includes(o.id) && f.severity !== 'suggestion') ? 'covered' : 'partial';
    o.chapterIds.sort();
  }

  const order: Record<AlignmentSeverity, number> = { critical: 0, warning: 1, suggestion: 2 };
  const ruleOrder = ['A1', 'A3', 'A5', 'A2', 'A6', 'A4', 'A7', 'P1', 'P2', 'P3'];
  const sorted = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => order[a.f.severity] - order[b.f.severity] || ruleOrder.indexOf(a.f.rule) - ruleOrder.indexOf(b.f.rule) || a.i - b.i)
    .map(({ f }, n) => ({ id: `AL${String(n + 1).padStart(3, '0')}`, ...f }));
  const list = [...outcomes.values()];
  const counts = { critical: 0, warning: 0, suggestion: 0 };
  for (const f of sorted) counts[f.severity]++;
  const body = {
    alignmentVersion: ALIGNMENT_VERSION,
    ruleset: ALIGNMENT_RULESET,
    available: true as const,
    blueprintSha256: input.blueprintSha256 ?? null,
    approach,
    thresholds,
    outcomes: list,
    chapters: chapterRows,
    findings: sorted,
    counts,
    coverage: { outcomes: list.length, covered: list.filter((o) => o.status === 'covered').length, partial: list.filter((o) => o.status === 'partial').length, uncovered: list.filter((o) => o.status === 'uncovered').length },
  };
  return { ...body, reportSha256: sha256Canonical(body) };
}
