import { ENUM_TARGETS, LIST_TARGETS, SECTION_KINDS } from './vocabulary';

/**
 * Motor pedagógico V1 — etiquetas en español del vocabulario (las muestran la
 * UI y el reporte del dry-run). check-pedagogy-engine.js exige que todo valor
 * del vocabulario tenga etiqueta.
 */
export const PEDAGOGY_VALUE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  // module.opening
  competency_map: 'Mapa de competencias', driving_problem: 'Problema detonante', concrete_experience: 'Experiencia concreta',
  advance_organizer: 'Organizador previo', learning_contract: 'Metas y autodiagnóstico',
  // module.closing
  performance_check: 'Verificación del desempeño', solution_review: 'Revisión de la solución', reflection_synthesis: 'Síntesis reflexiva',
  concept_map_synthesis: 'Síntesis en mapa conceptual', self_assessment: 'Autoevaluación',
  // objectives.style
  observable_performance: 'Desempeño observable', problem_solving: 'Resolución de problemas', experiential: 'Experiencial',
  relational_understanding: 'Comprensión de relaciones', self_directed_goal: 'Metas autodirigidas',
  // content.type
  procedural_guide: 'Guía de desempeño', case_driven: 'Guiado por el caso', experience_debrief: 'Análisis de la experiencia',
  conceptual_network: 'Red de conceptos', modular_reference: 'Bloques de consulta',
  // video.style
  demonstration: 'Demostración', problem_trigger: 'Planteamiento del problema', scenario_dramatization: 'Situación dramatizada',
  concept_explainer: 'Explicación de concepto', micro_lecture: 'Micro-clase',
  // video.policy / activity.policy / reviewCards.policy
  keep: 'Como lo configuró el docente', every_chapter: 'En todos los capítulos', module_opening: 'Solo al abrir cada módulo', enable: 'Activar',
  // video.interactions
  performance_checkpoints: 'Puntos de verificación del desempeño', decision_points: 'Puntos de decisión', reflective_pauses: 'Pausas de reflexión',
  concept_checks: 'Comprobaciones de concepto', self_check: 'Autocomprobación',
  // activity.intent
  apply: 'Aplicar', decide: 'Decidir', simulate: 'Simular', relate: 'Relacionar',
  // assessment.strategy
  performance_evidence: 'Evidencias de desempeño', solution_evaluation: 'Evaluación de la solución', reflective_evidence: 'Evidencias y reflexión',
  conceptual_understanding: 'Comprensión conceptual',
  // assessment.examStyle
  situational_cases: 'Casos situacionales', problem_scenarios: 'Problemas nuevos', experience_based_cases: 'Casos desde la experiencia',
  conceptual_relations: 'Relaciones entre conceptos', self_check_bank: 'Banco de autocomprobación',
  // assessment.finalExamStyle
  integrative_performance_case: 'Caso integrador de desempeño', integrative_problem: 'Problema integrador', integrative_experience: 'Experiencia integradora',
  integrative_concept_synthesis: 'Síntesis conceptual integradora', self_assessment_plus_test: 'Autoevaluación + prueba',
  // feedback.mode / timing
  criterion_referenced: 'Por criterios', guided_hints: 'Pistas guiadas', reflective_prompts: 'Preguntas de reflexión',
  elaborative_explanation: 'Explicación elaborada', self_check_keys: 'Claves de autocorrección', immediate: 'Inmediata', after_attempt: 'Después del intento',
  // scenarios.type
  workplace_situation: 'Situación del puesto de trabajo', ill_structured_problem: 'Problema abierto', simulated_experience: 'Experiencia simulada',
  analogy_case: 'Caso por analogía', self_selected_case: 'Caso propio del participante',
  // activity types
  branchingscenario: 'Escenario ramificado', questionset: 'Preguntas situacionales', dragtext: 'Arrastrar y ordenar', blanks: 'Completar',
  // resources
  checklist: 'Lista de verificación', job_aid: 'Ayuda de trabajo', performance_rubric: 'Rúbrica de desempeño', case_library: 'Banco de casos',
  research_sources: 'Fuentes para investigar', reflection_journal: 'Diario de reflexión', glossary: 'Glosario', concept_map: 'Mapa conceptual',
  learning_plan: 'Plan de aprendizaje', self_assessment_rubric: 'Rúbrica de autoevaluación', further_reading: 'Lecturas de ampliación',
  review_cards: 'Tarjetas de repaso',
  // derivados
  introductory: 'Introductoria', standard: 'Estándar', advanced: 'Avanzada', high: 'Alta', medium: 'Media', low: 'Baja',
});

/** Rol del capítulo dentro de su módulo (mapa aparte: «module_opening» también es un valor de video.policy). */
export const PEDAGOGY_ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  module_opening: 'Apertura del módulo', core: 'Desarrollo', module_closing: 'Cierre del módulo', single: 'Único del módulo',
});

export const PEDAGOGY_SECTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  competency_objectives: 'Objetivos de desempeño', real_situation: 'Situación real', key_concepts: 'Conceptos clave', demonstration: 'Demostración',
  guided_practice: 'Práctica guiada', autonomous_practice: 'Práctica autónoma', performance_evidence: 'Evidencia de desempeño',
  performance_feedback: 'Retroalimentación por criterios', driving_problem: 'Problema detonante', problem_analysis: 'Análisis del problema',
  knowledge_gaps: '¿Qué necesitamos saber?', research: 'Investigación', decision: 'Toma de decisiones', solution_proposal: 'Propuesta de solución',
  solution_evaluation: 'Evaluación de la solución', concrete_experience: 'Experiencia concreta', reflective_observation: 'Observación reflexiva',
  abstract_conceptualization: 'Conceptualización', active_experimentation: 'Experimentación activa', transfer: 'Transferencia',
  activate_prior_knowledge: 'Activar lo que ya sabes', advance_organizer: 'Organizador previo', concept_relations: 'Relaciones entre conceptos',
  worked_example: 'Ejemplo resuelto', integrative_reconciliation: 'Integración', application: 'Aplicación', concept_map_synthesis: 'Mapa conceptual',
  learning_goals: 'Mis metas', self_diagnosis: 'Autodiagnóstico', learning_path: 'Mi ruta', modular_content: 'Contenido por bloques',
  self_paced_practice: 'Práctica a mi ritmo', self_assessment: 'Autoevaluación', reflection_plan: 'Reflexión y próximo paso',
});

export const PEDAGOGY_TARGET_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'module.opening': 'Apertura del módulo', 'module.closing': 'Cierre del módulo', 'objectives.style': 'Estilo de objetivos',
  'content.type': 'Tipo de contenido', 'video.style': 'Estilo de video', 'video.policy': 'Videos por capítulo',
  'video.interactions': 'Interacciones del video', 'activity.intent': 'Intención de la actividad', 'activity.policy': 'Actividades por capítulo',
  'assessment.strategy': 'Estrategia de evaluación', 'assessment.examStyle': 'Evaluaciones de módulo', 'assessment.finalExamStyle': 'Evaluación final',
  'feedback.mode': 'Retroalimentación', 'feedback.timing': 'Momento de la retroalimentación', 'scenarios.type': 'Escenarios',
  'reviewCards.policy': 'Tarjetas de repaso', 'activity.preferredTypes': 'Tipos de actividad preferidos', resources: 'Recursos complementarios',
});

/** Valores del vocabulario sin etiqueta (vacío = completo). */
export function missingPedagogyLabels(): string[] {
  const missing: string[] = [];
  for (const values of Object.values(ENUM_TARGETS)) for (const v of values) if (!PEDAGOGY_VALUE_LABELS[v]) missing.push(v);
  for (const values of Object.values(LIST_TARGETS)) for (const v of values) if (!PEDAGOGY_VALUE_LABELS[v]) missing.push(v);
  for (const s of SECTION_KINDS) if (!PEDAGOGY_SECTION_LABELS[s]) missing.push(`section:${s}`);
  for (const t of [...Object.keys(ENUM_TARGETS), ...Object.keys(LIST_TARGETS)]) if (!PEDAGOGY_TARGET_LABELS[t]) missing.push(`target:${t}`);
  return [...new Set(missing)];
}
