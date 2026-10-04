/**
 * Motor pedagógico V1 — vocabulario cerrado del diseño.
 *
 * Todo lo que el motor de reglas puede decidir está acá: dimensiones, metas
 * (targets) y los valores permitidos de cada meta. Los enfoques (approaches)
 * son DATOS que votan sobre estas metas; el motor (design-rules.ts) no conoce
 * ningún enfoque por nombre. Agregar un enfoque nuevo = un objeto más en el
 * registro, sin tocar este archivo ni el motor (salvo que el enfoque necesite
 * un valor de diseño que todavía no existe: eso sí es una versión nueva del
 * vocabulario, `PEDAGOGY_ENGINE_VERSION`).
 *
 * Lógica PURA: sin DB, sin reloj, sin red, sin proveedores.
 */

/** Versión del motor (vocabulario + algoritmo). Entra en el Blueprint y en el Manifest. */
export const PEDAGOGY_ENGINE_VERSION = 1;

// ── Dimensiones pedagógicas (0..1) ──────────────────────────────────────────

export const PEDAGOGICAL_DIMENSIONS = [
  'practice', // peso de la práctica frente a la teoría
  'authenticity', // situaciones reales del trabajo / la vida
  'problemFirst', // el problema llega antes que la teoría
  'guidance', // 1 = muy guiado, 0 = autónomo
  'reflection', // reflexión explícita sobre lo vivido / aprendido
  'priorKnowledge', // activación de conocimientos previos
  'evidence', // evidencias de desempeño observables
  'inquiry', // investigación / descubrimiento
  'conceptualDepth', // red de conceptos y sus relaciones
  'selfRegulation', // metas, ritmo y autoevaluación del propio estudiante
  'interactivity', // densidad de interacción en el curso
] as const;
export type PedagogicalDimension = (typeof PEDAGOGICAL_DIMENSIONS)[number];
export type PedagogicalDimensions = Record<PedagogicalDimension, number>;

// ── Metas de diseño (valores cerrados) ──────────────────────────────────────

/** Metas de elección única: cada enfoque vota un valor con un peso; gana el mayor puntaje ponderado. */
export const ENUM_TARGETS = {
  'module.opening': ['competency_map', 'driving_problem', 'concrete_experience', 'advance_organizer', 'learning_contract'],
  'module.closing': ['performance_check', 'solution_review', 'reflection_synthesis', 'concept_map_synthesis', 'self_assessment'],
  'objectives.style': ['observable_performance', 'problem_solving', 'experiential', 'relational_understanding', 'self_directed_goal'],
  'content.type': ['procedural_guide', 'case_driven', 'experience_debrief', 'conceptual_network', 'modular_reference'],
  'video.style': ['demonstration', 'problem_trigger', 'scenario_dramatization', 'concept_explainer', 'micro_lecture'],
  'video.policy': ['keep', 'every_chapter', 'module_opening'],
  'video.interactions': ['performance_checkpoints', 'decision_points', 'reflective_pauses', 'concept_checks', 'self_check'],
  'activity.intent': ['apply', 'decide', 'simulate', 'relate', 'self_check'],
  'activity.policy': ['keep', 'every_chapter'],
  'assessment.strategy': ['performance_evidence', 'solution_evaluation', 'reflective_evidence', 'conceptual_understanding', 'self_assessment'],
  'assessment.examStyle': ['situational_cases', 'problem_scenarios', 'experience_based_cases', 'conceptual_relations', 'self_check_bank'],
  'assessment.finalExamStyle': ['integrative_performance_case', 'integrative_problem', 'integrative_experience', 'integrative_concept_synthesis', 'self_assessment_plus_test'],
  'feedback.mode': ['criterion_referenced', 'guided_hints', 'reflective_prompts', 'elaborative_explanation', 'self_check_keys'],
  'feedback.timing': ['immediate', 'after_attempt'],
  'scenarios.type': ['workplace_situation', 'ill_structured_problem', 'simulated_experience', 'analogy_case', 'self_selected_case'],
  'reviewCards.policy': ['keep', 'enable'],
} as const;
export type EnumTarget = keyof typeof ENUM_TARGETS;
export type EnumTargetValue<T extends EnumTarget> = (typeof ENUM_TARGETS)[T][number];

/** Metas de lista: los enfoques aportan elementos ordenados; se combinan por puntaje (Borda ponderado). */
export const LIST_TARGETS = {
  'activity.preferredTypes': ['branchingscenario', 'questionset', 'dragtext', 'blanks'],
  resources: [
    'checklist', 'job_aid', 'performance_rubric', 'case_library', 'research_sources', 'reflection_journal',
    'glossary', 'concept_map', 'advance_organizer', 'learning_plan', 'self_assessment_rubric', 'further_reading', 'review_cards',
  ],
} as const;
export type ListTarget = keyof typeof LIST_TARGETS;

/** Pasos posibles de la secuencia de un capítulo (orden lo decide cada enfoque). */
export const SECTION_KINDS = [
  // competencias
  'competency_objectives', 'real_situation', 'key_concepts', 'demonstration', 'guided_practice', 'autonomous_practice',
  'performance_evidence', 'performance_feedback',
  // problemas
  'driving_problem', 'problem_analysis', 'knowledge_gaps', 'research', 'decision', 'solution_proposal', 'solution_evaluation',
  // experiencial (Kolb)
  'concrete_experience', 'reflective_observation', 'abstract_conceptualization', 'active_experimentation', 'transfer',
  // significativo (Ausubel)
  'activate_prior_knowledge', 'advance_organizer', 'concept_relations', 'worked_example', 'integrative_reconciliation',
  'application', 'concept_map_synthesis',
  // autodirigido
  'learning_goals', 'self_diagnosis', 'learning_path', 'modular_content', 'self_paced_practice', 'self_assessment',
  'reflection_plan',
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** Rol de un capítulo dentro de su módulo (algunas reglas solo aplican al primero o al último). */
export type ChapterRole = 'module_opening' | 'core' | 'module_closing' | 'single';

// ── Opciones de las preguntas de «No estoy seguro» (ids estables) ──────────

export const AGE_GROUPS = ['children', 'teens', 'adults', 'mixed'] as const;
export const EDUCATION_LEVELS = ['basic', 'secondary', 'technical', 'university', 'professional'] as const;
export const PRIOR_KNOWLEDGE_LEVELS = ['none', 'basic', 'intermediate', 'advanced'] as const;
export const EXPERIENCE_LEVELS = ['none', 'some', 'extensive'] as const;

/** P3 — ¿Cómo quieres que aprendan principalmente? */
export const LEARNING_MODES = ['concepts', 'problems', 'projects', 'practice', 'inquiry', 'collaborative', 'real_application', 'combination'] as const;
/** P4 — ¿Qué tipo de experiencia quieres que tenga el estudiante? */
export const EXPERIENCE_TYPES = ['autonomous', 'teacher_guided', 'interactive_collaborative', 'practice_experimentation', 'challenges', 'combination'] as const;
/** P5 — ¿Cómo quieres comprobar que aprendió? */
export const ASSESSMENT_METHODS = ['quizzes', 'practical_exercises', 'cases', 'projects', 'products_evidence', 'self_reflection', 'peer', 'combination'] as const;
/** P6 — ¿Hay alguna metodología que quieras priorizar? */
export const PRIORITY_ANSWERS = ['yes', 'no', 'unsure'] as const;

export type AgeGroup = (typeof AGE_GROUPS)[number];
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];
export type PriorKnowledgeLevel = (typeof PRIOR_KNOWLEDGE_LEVELS)[number];
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];
export type LearningMode = (typeof LEARNING_MODES)[number];
export type ExperienceType = (typeof EXPERIENCE_TYPES)[number];
export type AssessmentMethod = (typeof ASSESSMENT_METHODS)[number];
export type PriorityAnswer = (typeof PRIORITY_ANSWERS)[number];

export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** Redondeo a 2 decimales (todo número que entra en un JSON canónico pasa por acá). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
