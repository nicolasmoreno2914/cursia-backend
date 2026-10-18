/**
 * Motor pedagógico V1 — forma del diseño pedagógico dentro del Blueprint v2.
 *
 * Sin imports del motor a propósito (lo usa blueprint-snapshot.ts; el motor importa
 * blueprint-snapshot.ts: este archivo corta el ciclo). Solo el vocabulario (vocabulary.ts, sin imports).
 *
 * Claves en el snapshot (SOLO cuando el curso tiene perfil pedagógico; sin
 * perfil el JSON canónico es byte a byte el de antes):
 *   course.pedagogy   — resumen: enfoques, motor, estrategia de evaluación…
 *   module.design     — apertura y cierre del módulo
 *   chapter.design    — secuencia, tipo de contenido, video, actividad…
 * Los canonicalizadores construyen objetos NUEVOS en orden de claves fijo y
 * fallan fuerte ante un tipo inválido (nunca "arreglan" en silencio).
 */

import { LEARNING_TYPES } from './vocabulary';

/** T2 (r57): plan de aprendizaje congelado del curso (marco por defecto + rótulos visibles). */
export interface CourseLearningPlanDesign {
  version: number;
  framework: string;
  phaseLabels: boolean;
}

/** T2 (r57): tipo de aprendizaje congelado de un capítulo, con su justificación (learning-type.ts). */
export interface ChapterLearningTypeFrozen {
  type: string;
  source: 'rules' | 'override';
  rulesVersion: number;
  ruleId: string;
  level: string | null;
  evidence: { field: string; cue: string; kind: string }[];
  suggested?: string;
}

export interface CoursePedagogyDesign {
  engineVersion: number;
  profileSha256: string;
  approaches: { id: string; role: 'primary' | 'secondary'; weight: number }[];
  objectivesStyle: string;
  contentDepth: string;
  interactionLevel: string;
  assessment: {
    strategy: string;
    examStyle: string;
    finalExamStyle: string;
    feedbackMode: string;
    feedbackTiming: string;
    suggestedWeights: { practice: number; moduleExams: number; finalExam: number };
  };
  principles: string[];
  /**
   * Variaciones por ROL del capítulo en su módulo (apertura / desarrollo / cierre / único): meta → valor.
   * El rol depende de la POSICIÓN, así que no se congela por capítulo: el Manifest lo resuelve al
   * construirse (como la numeración). Así un reorden puro no cambia el diseño congelado del Blueprint
   * ni sus huellas (review I2).
   */
  roleTargets: Record<string, Record<string, string>>;
  /** T2 (r57): SOLO con plan de aprendizaje (sin él, el JSON es el de siempre). */
  learningPlan?: CourseLearningPlanDesign;
}

export interface ModuleDesign {
  opening: string;
  closing: string;
  /** T2 (r57): marco del módulo (SOLO con plan de aprendizaje). */
  framework?: string;
}

/** Diseño de un capítulo, independiente de su posición (ver CoursePedagogyDesign.roleTargets). */
export interface ChapterDesign {
  sequence: string[];
  objectiveStyle: string;
  objectiveVerbs: string[];
  contentType: string;
  depth: string;
  video: { style: string; interactions: string };
  activity: { intent: string; preferredTypes: string[] };
  scenario: { type: string; branching: boolean };
  feedback: { mode: string; timing: string };
  resources: string[];
  /** T2 (r57): SOLO con plan de aprendizaje. */
  learningType?: ChapterLearningTypeFrozen;
  /** T2 (r57): marco del capítulo (curso, módulo u override). SOLO con plan de aprendizaje. */
  framework?: string;
}

/** Diseño completo listo para el builder del Blueprint (todo módulo y capítulo del curso). */
export interface BlueprintPedagogyInput {
  course: CoursePedagogyDesign;
  modules: Record<string, ModuleDesign>;
  chapters: Record<string, ChapterDesign>;
}

function fail(path: string, msg: string): never {
  throw new Error(`BLUEPRINT_PEDAGOGY_INVALID: ${path}: ${msg}`);
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v) fail(path, `debe ser un texto no vacío (fue ${JSON.stringify(v)})`);
  return v as string;
}
function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `debe ser un número (fue ${JSON.stringify(v)})`);
  return v as number;
}
function strList(v: unknown, path: string): string[] {
  if (!Array.isArray(v)) fail(path, 'debe ser un array');
  return (v as unknown[]).map((x, i) => str(x, `${path}[${i}]`));
}
function obj(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path, 'debe ser un objeto');
  return v as Record<string, unknown>;
}

export function canonicalCoursePedagogy(v: unknown): CoursePedagogyDesign {
  const o = obj(v, 'course.pedagogy');
  const a = obj(o.assessment, 'course.pedagogy.assessment');
  const w = obj(a.suggestedWeights, 'course.pedagogy.assessment.suggestedWeights');
  if (!Array.isArray(o.approaches) || o.approaches.length === 0) fail('course.pedagogy.approaches', 'al menos un enfoque');
  return {
    engineVersion: num(o.engineVersion, 'course.pedagogy.engineVersion'),
    profileSha256: str(o.profileSha256, 'course.pedagogy.profileSha256'),
    approaches: (o.approaches as unknown[]).map((x, i) => {
      const e = obj(x, `course.pedagogy.approaches[${i}]`);
      if (e.role !== 'primary' && e.role !== 'secondary') fail(`course.pedagogy.approaches[${i}].role`, "debe ser 'primary' o 'secondary'");
      return { id: str(e.id, `course.pedagogy.approaches[${i}].id`), role: e.role as 'primary' | 'secondary', weight: num(e.weight, `course.pedagogy.approaches[${i}].weight`) };
    }),
    objectivesStyle: str(o.objectivesStyle, 'course.pedagogy.objectivesStyle'),
    contentDepth: str(o.contentDepth, 'course.pedagogy.contentDepth'),
    interactionLevel: str(o.interactionLevel, 'course.pedagogy.interactionLevel'),
    assessment: {
      strategy: str(a.strategy, 'course.pedagogy.assessment.strategy'),
      examStyle: str(a.examStyle, 'course.pedagogy.assessment.examStyle'),
      finalExamStyle: str(a.finalExamStyle, 'course.pedagogy.assessment.finalExamStyle'),
      feedbackMode: str(a.feedbackMode, 'course.pedagogy.assessment.feedbackMode'),
      feedbackTiming: str(a.feedbackTiming, 'course.pedagogy.assessment.feedbackTiming'),
      suggestedWeights: {
        practice: num(w.practice, 'suggestedWeights.practice'),
        moduleExams: num(w.moduleExams, 'suggestedWeights.moduleExams'),
        finalExam: num(w.finalExam, 'suggestedWeights.finalExam'),
      },
    },
    principles: Array.isArray(o.principles) ? (o.principles as unknown[]).map((x, i) => str(x, `course.pedagogy.principles[${i}]`)) : fail('course.pedagogy.principles', 'debe ser un array'),
    roleTargets: canonicalRoleTargets(o.roleTargets),
    ...(o.learningPlan !== undefined ? { learningPlan: canonicalCourseLearningPlan(o.learningPlan) } : {}),
  };
}

function canonicalCourseLearningPlan(v: unknown): CourseLearningPlanDesign {
  const o = obj(v, 'course.pedagogy.learningPlan');
  if (typeof o.phaseLabels !== 'boolean') fail('course.pedagogy.learningPlan.phaseLabels', 'debe ser boolean');
  return { version: num(o.version, 'course.pedagogy.learningPlan.version'), framework: str(o.framework, 'course.pedagogy.learningPlan.framework'), phaseLabels: o.phaseLabels as boolean };
}

function canonicalLearningType(v: unknown, path: string): ChapterLearningTypeFrozen {
  const o = obj(v, path);
  const type = str(o.type, `${path}.type`);
  if (!(LEARNING_TYPES as readonly string[]).includes(type)) fail(`${path}.type`, `tipo de aprendizaje desconocido (${LEARNING_TYPES.join(', ')})`);
  if (o.source !== 'rules' && o.source !== 'override') fail(`${path}.source`, "debe ser 'rules' u 'override'");
  if (o.level !== null && typeof o.level !== 'string') fail(`${path}.level`, 'debe ser texto o null');
  if (!Array.isArray(o.evidence)) fail(`${path}.evidence`, 'debe ser un array');
  const out: ChapterLearningTypeFrozen = {
    type,
    source: o.source as 'rules' | 'override',
    rulesVersion: num(o.rulesVersion, `${path}.rulesVersion`),
    ruleId: str(o.ruleId, `${path}.ruleId`),
    level: (o.level as string | null),
    evidence: (o.evidence as unknown[]).map((x, i) => {
      const e = obj(x, `${path}.evidence[${i}]`);
      return { field: str(e.field, `${path}.evidence[${i}].field`), cue: str(e.cue, `${path}.evidence[${i}].cue`), kind: str(e.kind, `${path}.evidence[${i}].kind`) };
    }),
  };
  if (o.suggested !== undefined) {
    const sg = str(o.suggested, `${path}.suggested`);
    if (!(LEARNING_TYPES as readonly string[]).includes(sg)) fail(`${path}.suggested`, 'tipo de aprendizaje desconocido');
    out.suggested = sg;
  }
  return out;
}

/** Roles y metas en orden alfabético (determinístico, independiente del orden de jsonb). */
function canonicalRoleTargets(v: unknown): Record<string, Record<string, string>> {
  const o = obj(v, 'course.pedagogy.roleTargets');
  const out: Record<string, Record<string, string>> = {};
  for (const role of Object.keys(o).sort()) {
    const t = obj(o[role], `course.pedagogy.roleTargets.${role}`);
    const inner: Record<string, string> = {};
    for (const k of Object.keys(t).sort()) inner[k] = str(t[k], `course.pedagogy.roleTargets.${role}.${k}`);
    out[role] = inner;
  }
  return out;
}

export function canonicalModuleDesign(v: unknown, path = 'module.design'): ModuleDesign {
  const o = obj(v, path);
  return {
    opening: str(o.opening, `${path}.opening`),
    closing: str(o.closing, `${path}.closing`),
    ...(o.framework !== undefined ? { framework: str(o.framework, `${path}.framework`) } : {}),
  };
}

export function canonicalChapterDesign(v: unknown, path = 'chapter.design'): ChapterDesign {
  const o = obj(v, path);
  const video = obj(o.video, `${path}.video`);
  const activity = obj(o.activity, `${path}.activity`);
  const scenario = obj(o.scenario, `${path}.scenario`);
  const feedback = obj(o.feedback, `${path}.feedback`);
  if (typeof scenario.branching !== 'boolean') fail(`${path}.scenario.branching`, 'debe ser boolean');
  return {
    sequence: strList(o.sequence, `${path}.sequence`),
    objectiveStyle: str(o.objectiveStyle, `${path}.objectiveStyle`),
    objectiveVerbs: strList(o.objectiveVerbs, `${path}.objectiveVerbs`),
    contentType: str(o.contentType, `${path}.contentType`),
    depth: str(o.depth, `${path}.depth`),
    video: { style: str(video.style, `${path}.video.style`), interactions: str(video.interactions, `${path}.video.interactions`) },
    activity: { intent: str(activity.intent, `${path}.activity.intent`), preferredTypes: strList(activity.preferredTypes, `${path}.activity.preferredTypes`) },
    scenario: { type: str(scenario.type, `${path}.scenario.type`), branching: scenario.branching as boolean },
    feedback: { mode: str(feedback.mode, `${path}.feedback.mode`), timing: str(feedback.timing, `${path}.feedback.timing`) },
    resources: strList(o.resources, `${path}.resources`),
    ...(o.learningType !== undefined ? { learningType: canonicalLearningType(o.learningType, `${path}.learningType`) } : {}),
    ...(o.framework !== undefined ? { framework: str(o.framework, `${path}.framework`) } : {}),
  };
}
