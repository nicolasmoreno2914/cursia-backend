/**
 * Motor pedagógico V1 — forma del diseño pedagógico dentro del Blueprint v2.
 *
 * Sin imports a propósito (lo usa blueprint-snapshot.ts; el motor importa
 * blueprint-snapshot.ts: este archivo corta el ciclo).
 *
 * Claves en el snapshot (SOLO cuando el curso tiene perfil pedagógico; sin
 * perfil el JSON canónico es byte a byte el de antes):
 *   course.pedagogy   — resumen: enfoques, motor, estrategia de evaluación…
 *   module.design     — apertura y cierre del módulo
 *   chapter.design    — secuencia, tipo de contenido, video, actividad…
 * Los canonicalizadores construyen objetos NUEVOS en orden de claves fijo y
 * fallan fuerte ante un tipo inválido (nunca "arreglan" en silencio).
 */

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
}

export interface ModuleDesign {
  opening: string;
  closing: string;
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
  };
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
  return { opening: str(o.opening, `${path}.opening`), closing: str(o.closing, `${path}.closing`) };
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
  };
}
