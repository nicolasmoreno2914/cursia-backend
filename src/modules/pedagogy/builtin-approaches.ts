import { PedagogicalApproachDefinition, PedagogicalApproachRegistry } from './approach-registry';

/**
 * Motor pedagógico V1 — los 5 enfoques iniciales, como DATOS.
 *
 * Cada voto lleva su `ruleId` (traza en el dry-run) y su `rationale`
 * (explicación en español para el usuario). Los pesos (0..1) solo importan
 * cuando se combinan enfoques: deciden qué enfoque manda en cada meta.
 */

export const APPROACH_COMPETENCIAS: PedagogicalApproachDefinition = {
  id: 'competencias',
  label: 'Aprendizaje basado en competencias',
  shortLabel: 'Competencias',
  summary: 'El curso se organiza alrededor de desempeños observables: qué debe saber hacer el participante, en qué situación y con qué criterio.',
  dimensions: {
    practice: 0.85, authenticity: 0.85, problemFirst: 0.35, guidance: 0.6, reflection: 0.35, priorKnowledge: 0.35,
    evidence: 0.95, inquiry: 0.2, conceptualDepth: 0.4, selfRegulation: 0.35, interactivity: 0.75,
  },
  votes: {
    'module.opening': { value: 'competency_map', weight: 0.8, ruleId: 'comp.module.competency_map', rationale: 'Cada módulo abre con el mapa de competencias: qué hará el participante y con qué criterio se verificará.' },
    'module.closing': { value: 'performance_check', weight: 0.9, ruleId: 'comp.module.performance_check', rationale: 'El módulo cierra verificando el desempeño, no repasando teoría.' },
    'objectives.style': { value: 'observable_performance', weight: 0.95, ruleId: 'comp.objectives.observable', rationale: 'Los objetivos se redactan como desempeños observables (verbo + condición + criterio).' },
    'content.type': { value: 'procedural_guide', weight: 0.8, ruleId: 'comp.content.procedural', rationale: 'El contenido se presenta como guía de desempeño: pasos, criterios y errores frecuentes.' },
    'video.style': { value: 'demonstration', weight: 0.85, ruleId: 'comp.video.demonstration', rationale: 'El video modela el desempeño esperado (demostración paso a paso).' },
    'video.policy': { value: 'every_chapter', weight: 0.6, ruleId: 'comp.video.every_chapter', rationale: 'Cada competencia se modela con su propia demostración en video.' },
    'video.interactions': { value: 'performance_checkpoints', weight: 0.8, ruleId: 'comp.video.checkpoints', rationale: 'Las pausas del video verifican si el participante reconoce el desempeño correcto.' },
    'activity.intent': { value: 'apply', weight: 0.9, ruleId: 'comp.activity.apply', rationale: 'La práctica aplica el procedimiento en una situación real del puesto.' },
    'activity.policy': { value: 'every_chapter', weight: 0.8, ruleId: 'comp.activity.every_chapter', rationale: 'Sin práctica no hay evidencia: todos los capítulos llevan actividad.' },
    'assessment.strategy': { value: 'performance_evidence', weight: 0.95, ruleId: 'comp.assessment.evidence', rationale: 'Se evalúa con evidencias de desempeño contra criterios explícitos.' },
    'assessment.examStyle': { value: 'situational_cases', weight: 0.85, ruleId: 'comp.exam.situational', rationale: 'Las evaluaciones de módulo usan situaciones del trabajo, no definiciones.' },
    'assessment.finalExamStyle': { value: 'integrative_performance_case', weight: 0.9, ruleId: 'comp.final.performance_case', rationale: 'La evaluación final integra las competencias en un caso de desempeño completo.' },
    'feedback.mode': { value: 'criterion_referenced', weight: 0.85, ruleId: 'comp.feedback.criteria', rationale: 'La retroalimentación dice qué criterio se cumplió y cuál falta.' },
    'feedback.timing': { value: 'immediate', weight: 0.6, ruleId: 'comp.feedback.immediate', rationale: 'Corregir el desempeño en el momento evita fijar errores de procedimiento.' },
    'scenarios.type': { value: 'workplace_situation', weight: 0.85, ruleId: 'comp.scenarios.workplace', rationale: 'Los escenarios reproducen situaciones reales del puesto de trabajo.' },
    'reviewCards.policy': { value: 'keep', weight: 0.3, ruleId: 'comp.review.keep', rationale: 'El repaso queda como lo configuró el docente.' },
  },
  lists: {
    'activity.preferredTypes': { items: ['branchingscenario', 'questionset', 'dragtext', 'blanks'], weight: 0.8, ruleId: 'comp.activity.types', rationale: 'Primero escenarios de decisión y preguntas situacionales; luego secuenciar procedimientos.' },
    resources: { items: ['checklist', 'performance_rubric', 'job_aid'], weight: 0.7, ruleId: 'comp.resources', rationale: 'Listas de verificación, rúbrica de desempeño y ayudas de trabajo para el puesto.' },
  },
  sequence: ['competency_objectives', 'real_situation', 'key_concepts', 'demonstration', 'guided_practice', 'autonomous_practice', 'performance_evidence', 'performance_feedback'],
  signatureSteps: [{ step: 'performance_evidence', at: 'end' }],
  roleOverrides: {
    module_closing: {
      'activity.intent': { value: 'simulate', weight: 0.95, ruleId: 'comp.closing.simulate', rationale: 'El último capítulo del módulo integra las competencias en una simulación de desempeño.' },
    },
  },
  objectiveVerbs: ['aplicar', 'ejecutar', 'realizar', 'demostrar', 'identificar', 'verificar', 'registrar'],
  affinity: {
    learningModes: { concepts: 0.2, problems: 0.55, projects: 0.6, practice: 0.95, inquiry: 0.2, collaborative: 0.35, real_application: 0.95 },
    experienceTypes: { autonomous: 0.45, teacher_guided: 0.6, interactive_collaborative: 0.4, practice_experimentation: 0.85, challenges: 0.55 },
    assessmentMethods: { quizzes: 0.35, practical_exercises: 0.9, cases: 0.7, projects: 0.6, products_evidence: 0.95, self_reflection: 0.3, peer: 0.35 },
    priorKnowledge: { none: 0.55, basic: 0.7, intermediate: 0.75, advanced: 0.6 },
    experience: { none: 0.5, some: 0.75, extensive: 0.7 },
    ageGroups: { children: 0.3, teens: 0.55, adults: 0.85, mixed: 0.6 },
    outcomes: { know: 0.3, do: 0.95, competencies: 1 },
  },
};

export const APPROACH_PROBLEMAS: PedagogicalApproachDefinition = {
  id: 'problemas',
  label: 'Aprendizaje basado en problemas',
  shortLabel: 'Problemas',
  summary: 'Cada módulo parte de un problema real y abierto; la teoría llega cuando el participante la necesita para resolverlo.',
  dimensions: {
    practice: 0.7, authenticity: 0.8, problemFirst: 0.95, guidance: 0.4, reflection: 0.5, priorKnowledge: 0.5,
    evidence: 0.6, inquiry: 0.85, conceptualDepth: 0.6, selfRegulation: 0.55, interactivity: 0.7,
  },
  votes: {
    'module.opening': { value: 'driving_problem', weight: 0.95, ruleId: 'abp.module.driving_problem', rationale: 'El módulo abre con un problema detonante que da sentido a todos sus capítulos.' },
    'module.closing': { value: 'solution_review', weight: 0.85, ruleId: 'abp.module.solution_review', rationale: 'El módulo cierra revisando la solución propuesta y lo que se aprendió al construirla.' },
    'objectives.style': { value: 'problem_solving', weight: 0.85, ruleId: 'abp.objectives.problem', rationale: 'Los objetivos se redactan como resolución de problemas (analizar, decidir, justificar).' },
    'content.type': { value: 'case_driven', weight: 0.85, ruleId: 'abp.content.case', rationale: 'El contenido avanza guiado por el caso: cada concepto responde a una pregunta del problema.' },
    'video.style': { value: 'problem_trigger', weight: 0.9, ruleId: 'abp.video.trigger', rationale: 'El video plantea el problema (situación, datos, tensión) sin resolverlo.' },
    'video.policy': { value: 'module_opening', weight: 0.7, ruleId: 'abp.video.module_opening', rationale: 'Un video por módulo presenta el problema detonante; los capítulos siguientes investigan.' },
    'video.interactions': { value: 'decision_points', weight: 0.8, ruleId: 'abp.video.decisions', rationale: 'Las pausas del video piden una decisión o una hipótesis antes de continuar.' },
    'activity.intent': { value: 'decide', weight: 0.9, ruleId: 'abp.activity.decide', rationale: 'La práctica pide tomar decisiones sobre el caso y ver sus consecuencias.' },
    'activity.policy': { value: 'every_chapter', weight: 0.6, ruleId: 'abp.activity.every_chapter', rationale: 'Cada capítulo avanza la solución con una práctica.' },
    'assessment.strategy': { value: 'solution_evaluation', weight: 0.9, ruleId: 'abp.assessment.solution', rationale: 'Se evalúa la calidad de la solución y de su justificación.' },
    'assessment.examStyle': { value: 'problem_scenarios', weight: 0.85, ruleId: 'abp.exam.scenarios', rationale: 'Las evaluaciones de módulo presentan problemas nuevos parecidos al trabajado.' },
    'assessment.finalExamStyle': { value: 'integrative_problem', weight: 0.9, ruleId: 'abp.final.problem', rationale: 'La evaluación final es un problema integrador que cruza todos los módulos.' },
    'feedback.mode': { value: 'guided_hints', weight: 0.8, ruleId: 'abp.feedback.hints', rationale: 'La retroalimentación orienta con pistas y preguntas, sin dar la respuesta de entrada.' },
    'feedback.timing': { value: 'after_attempt', weight: 0.6, ruleId: 'abp.feedback.after_attempt', rationale: 'Primero se intenta resolver; después se explica.' },
    'scenarios.type': { value: 'ill_structured_problem', weight: 0.9, ruleId: 'abp.scenarios.ill_structured', rationale: 'Los escenarios son problemas abiertos, con información incompleta, como en la realidad.' },
    'reviewCards.policy': { value: 'keep', weight: 0.3, ruleId: 'abp.review.keep', rationale: 'El repaso queda como lo configuró el docente.' },
  },
  lists: {
    'activity.preferredTypes': { items: ['branchingscenario', 'questionset', 'blanks', 'dragtext'], weight: 0.85, ruleId: 'abp.activity.types', rationale: 'Escenarios ramificados para decidir; preguntas de caso para analizar.' },
    resources: { items: ['case_library', 'research_sources', 'glossary'], weight: 0.7, ruleId: 'abp.resources', rationale: 'Banco de casos y fuentes para investigar el problema.' },
  },
  sequence: ['driving_problem', 'problem_analysis', 'knowledge_gaps', 'research', 'key_concepts', 'decision', 'solution_proposal', 'solution_evaluation'],
  signatureSteps: [{ step: 'driving_problem', at: 'start' }, { step: 'solution_evaluation', at: 'end' }],
  objectiveVerbs: ['resolver', 'analizar', 'proponer', 'decidir', 'justificar', 'evaluar', 'priorizar'],
  affinity: {
    learningModes: { concepts: 0.25, problems: 1, projects: 0.7, practice: 0.5, inquiry: 0.85, collaborative: 0.6, real_application: 0.7 },
    experienceTypes: { autonomous: 0.5, teacher_guided: 0.35, interactive_collaborative: 0.6, practice_experimentation: 0.5, challenges: 1 },
    assessmentMethods: { quizzes: 0.25, practical_exercises: 0.5, cases: 1, projects: 0.7, products_evidence: 0.55, self_reflection: 0.45, peer: 0.6 },
    priorKnowledge: { none: 0.25, basic: 0.55, intermediate: 0.85, advanced: 0.85 },
    experience: { none: 0.35, some: 0.7, extensive: 0.8 },
    ageGroups: { children: 0.35, teens: 0.65, adults: 0.8, mixed: 0.6 },
    outcomes: { know: 0.45, do: 0.7, competencies: 0.7 },
  },
};

export const APPROACH_EXPERIENCIAL: PedagogicalApproachDefinition = {
  id: 'experiencial',
  label: 'Aprendizaje experiencial',
  shortLabel: 'Experiencial',
  summary: 'Se aprende viviendo una experiencia, reflexionando sobre ella, conceptualizando y volviendo a experimentar (ciclo de Kolb).',
  dimensions: {
    practice: 0.9, authenticity: 0.75, problemFirst: 0.55, guidance: 0.5, reflection: 0.95, priorKnowledge: 0.45,
    evidence: 0.55, inquiry: 0.5, conceptualDepth: 0.45, selfRegulation: 0.5, interactivity: 0.85,
  },
  votes: {
    'module.opening': { value: 'concrete_experience', weight: 0.95, ruleId: 'exp.module.concrete_experience', rationale: 'El módulo abre con una experiencia concreta (simulada) antes de cualquier explicación.' },
    'module.closing': { value: 'reflection_synthesis', weight: 0.9, ruleId: 'exp.module.reflection', rationale: 'El módulo cierra con una síntesis reflexiva de lo vivido y lo aprendido.' },
    'objectives.style': { value: 'experiential', weight: 0.8, ruleId: 'exp.objectives.experiential', rationale: 'Los objetivos describen lo que el participante experimentará y podrá transferir.' },
    'content.type': { value: 'experience_debrief', weight: 0.85, ruleId: 'exp.content.debrief', rationale: 'El contenido se arma como análisis (debriefing) de la experiencia vivida.' },
    'video.style': { value: 'scenario_dramatization', weight: 0.9, ruleId: 'exp.video.dramatization', rationale: 'El video dramatiza una situación para vivirla en primera persona.' },
    'video.policy': { value: 'every_chapter', weight: 0.7, ruleId: 'exp.video.every_chapter', rationale: 'Cada capítulo parte de una experiencia concreta en video.' },
    'video.interactions': { value: 'reflective_pauses', weight: 0.9, ruleId: 'exp.video.reflective', rationale: 'Las pausas del video invitan a observar y reflexionar sobre lo ocurrido.' },
    'activity.intent': { value: 'simulate', weight: 0.9, ruleId: 'exp.activity.simulate', rationale: 'La práctica es una simulación: actuar y ver qué pasa.' },
    'activity.policy': { value: 'every_chapter', weight: 0.8, ruleId: 'exp.activity.every_chapter', rationale: 'Sin experimentación no se cierra el ciclo: todos los capítulos llevan actividad.' },
    'assessment.strategy': { value: 'reflective_evidence', weight: 0.85, ruleId: 'exp.assessment.reflective', rationale: 'Se evalúa lo que el participante hace y cómo lo analiza.' },
    'assessment.examStyle': { value: 'experience_based_cases', weight: 0.8, ruleId: 'exp.exam.cases', rationale: 'Las evaluaciones de módulo parten de situaciones parecidas a las vividas.' },
    'assessment.finalExamStyle': { value: 'integrative_experience', weight: 0.85, ruleId: 'exp.final.experience', rationale: 'La evaluación final recorre una experiencia integradora completa.' },
    'feedback.mode': { value: 'reflective_prompts', weight: 0.9, ruleId: 'exp.feedback.reflective', rationale: 'La retroalimentación devuelve preguntas para reflexionar, además de la respuesta.' },
    'feedback.timing': { value: 'after_attempt', weight: 0.5, ruleId: 'exp.feedback.after_attempt', rationale: 'Primero se vive la consecuencia; después se analiza.' },
    'scenarios.type': { value: 'simulated_experience', weight: 0.9, ruleId: 'exp.scenarios.simulated', rationale: 'Los escenarios simulan la experiencia con consecuencias visibles.' },
    'reviewCards.policy': { value: 'keep', weight: 0.3, ruleId: 'exp.review.keep', rationale: 'El repaso queda como lo configuró el docente.' },
  },
  lists: {
    'activity.preferredTypes': { items: ['branchingscenario', 'questionset', 'dragtext', 'blanks'], weight: 0.85, ruleId: 'exp.activity.types', rationale: 'Escenarios ramificados para vivir consecuencias; preguntas situacionales cuando no cabe otro escenario; ordenar lo vivido para analizarlo.' },
    resources: { items: ['reflection_journal', 'case_library', 'checklist'], weight: 0.7, ruleId: 'exp.resources', rationale: 'Diario de reflexión y casos para volver a la experiencia.' },
  },
  sequence: ['concrete_experience', 'reflective_observation', 'abstract_conceptualization', 'active_experimentation', 'transfer'],
  signatureSteps: [{ step: 'reflective_observation', at: 'end' }, { step: 'transfer', at: 'end' }],
  roleOverrides: {
    module_closing: {
      'activity.intent': { value: 'apply', weight: 0.9, ruleId: 'exp.closing.apply', rationale: 'Cierre del ciclo: experimentación activa aplicando lo aprendido a una situación nueva.' },
    },
  },
  objectiveVerbs: ['experimentar', 'practicar', 'simular', 'aplicar', 'ensayar', 'contrastar'],
  affinity: {
    learningModes: { concepts: 0.15, problems: 0.55, projects: 0.65, practice: 1, inquiry: 0.55, collaborative: 0.6, real_application: 0.8 },
    experienceTypes: { autonomous: 0.4, teacher_guided: 0.4, interactive_collaborative: 0.7, practice_experimentation: 1, challenges: 0.6 },
    assessmentMethods: { quizzes: 0.2, practical_exercises: 0.85, cases: 0.6, projects: 0.6, products_evidence: 0.6, self_reflection: 0.95, peer: 0.55 },
    priorKnowledge: { none: 0.7, basic: 0.7, intermediate: 0.6, advanced: 0.5 },
    experience: { none: 0.7, some: 0.7, extensive: 0.6 },
    ageGroups: { children: 0.7, teens: 0.8, adults: 0.7, mixed: 0.7 },
    outcomes: { know: 0.3, do: 0.85, competencies: 0.6 },
  },
};

export const APPROACH_SIGNIFICATIVO: PedagogicalApproachDefinition = {
  id: 'significativo',
  label: 'Aprendizaje significativo',
  shortLabel: 'Significativo',
  summary: 'Lo nuevo se ancla en lo que el participante ya sabe: organizadores previos, red de conceptos y relaciones explícitas (Ausubel).',
  dimensions: {
    practice: 0.45, authenticity: 0.5, problemFirst: 0.25, guidance: 0.75, reflection: 0.5, priorKnowledge: 0.95,
    evidence: 0.35, inquiry: 0.4, conceptualDepth: 0.95, selfRegulation: 0.4, interactivity: 0.55,
  },
  votes: {
    'module.opening': { value: 'advance_organizer', weight: 0.95, ruleId: 'sig.module.advance_organizer', rationale: 'El módulo abre con un organizador previo que conecta con lo que el participante ya sabe.' },
    'module.closing': { value: 'concept_map_synthesis', weight: 0.9, ruleId: 'sig.module.concept_map', rationale: 'El módulo cierra con una síntesis de la red de conceptos (mapa conceptual).' },
    'objectives.style': { value: 'relational_understanding', weight: 0.85, ruleId: 'sig.objectives.relational', rationale: 'Los objetivos piden relacionar, explicar y diferenciar conceptos.' },
    'content.type': { value: 'conceptual_network', weight: 0.9, ruleId: 'sig.content.network', rationale: 'El contenido explicita las relaciones entre conceptos nuevos y previos.' },
    'video.style': { value: 'concept_explainer', weight: 0.9, ruleId: 'sig.video.explainer', rationale: 'El video explica un concepto anclándolo en ejemplos conocidos.' },
    'video.policy': { value: 'keep', weight: 0.4, ruleId: 'sig.video.keep', rationale: 'Los videos quedan donde el docente los puso.' },
    'video.interactions': { value: 'concept_checks', weight: 0.85, ruleId: 'sig.video.concept_checks', rationale: 'Las pausas del video verifican la comprensión de cada relación.' },
    'activity.intent': { value: 'relate', weight: 0.9, ruleId: 'sig.activity.relate', rationale: 'La práctica pide relacionar y clasificar conceptos.' },
    'activity.policy': { value: 'keep', weight: 0.4, ruleId: 'sig.activity.keep', rationale: 'Las actividades quedan como las configuró el docente.' },
    'assessment.strategy': { value: 'conceptual_understanding', weight: 0.85, ruleId: 'sig.assessment.understanding', rationale: 'Se evalúa la comprensión de relaciones, no la memoria de definiciones.' },
    'assessment.examStyle': { value: 'conceptual_relations', weight: 0.85, ruleId: 'sig.exam.relations', rationale: 'Las evaluaciones de módulo piden relacionar y aplicar conceptos.' },
    'assessment.finalExamStyle': { value: 'integrative_concept_synthesis', weight: 0.85, ruleId: 'sig.final.synthesis', rationale: 'La evaluación final integra la red completa de conceptos del curso.' },
    'feedback.mode': { value: 'elaborative_explanation', weight: 0.9, ruleId: 'sig.feedback.elaborative', rationale: 'La retroalimentación explica por qué, conectando con conceptos ya vistos.' },
    'feedback.timing': { value: 'immediate', weight: 0.7, ruleId: 'sig.feedback.immediate', rationale: 'Corregir enseguida evita anclar un concepto erróneo.' },
    'scenarios.type': { value: 'analogy_case', weight: 0.7, ruleId: 'sig.scenarios.analogy', rationale: 'Los casos usan analogías con situaciones conocidas.' },
    'reviewCards.policy': { value: 'enable', weight: 0.7, ruleId: 'sig.review.enable', rationale: 'Tarjetas de repaso para consolidar la red de conceptos.' },
  },
  lists: {
    'activity.preferredTypes': { items: ['dragtext', 'blanks', 'questionset', 'branchingscenario'], weight: 0.85, ruleId: 'sig.activity.types', rationale: 'Relacionar y completar conceptos antes que decidir.' },
    resources: { items: ['concept_map', 'advance_organizer', 'glossary', 'review_cards'], weight: 0.75, ruleId: 'sig.resources', rationale: 'Mapa conceptual, organizador previo y glosario.' },
  },
  sequence: ['activate_prior_knowledge', 'advance_organizer', 'key_concepts', 'concept_relations', 'worked_example', 'integrative_reconciliation', 'application', 'concept_map_synthesis'],
  signatureSteps: [{ step: 'activate_prior_knowledge', at: 'start' }, { step: 'concept_map_synthesis', at: 'end' }],
  objectiveVerbs: ['relacionar', 'explicar', 'comparar', 'clasificar', 'diferenciar', 'organizar', 'interpretar'],
  affinity: {
    learningModes: { concepts: 1, problems: 0.4, projects: 0.35, practice: 0.4, inquiry: 0.55, collaborative: 0.35, real_application: 0.55 },
    experienceTypes: { autonomous: 0.5, teacher_guided: 0.9, interactive_collaborative: 0.45, practice_experimentation: 0.4, challenges: 0.35 },
    assessmentMethods: { quizzes: 0.75, practical_exercises: 0.45, cases: 0.5, projects: 0.35, products_evidence: 0.45, self_reflection: 0.6, peer: 0.3 },
    priorKnowledge: { none: 0.9, basic: 0.85, intermediate: 0.6, advanced: 0.4 },
    experience: { none: 0.85, some: 0.6, extensive: 0.4 },
    ageGroups: { children: 0.8, teens: 0.85, adults: 0.6, mixed: 0.75 },
    outcomes: { know: 1, do: 0.4, competencies: 0.45 },
  },
};

export const APPROACH_AUTODIRIGIDO: PedagogicalApproachDefinition = {
  id: 'autodirigido',
  label: 'Aprendizaje autodirigido',
  shortLabel: 'Autodirigido',
  summary: 'El participante fija metas, elige su ruta y su ritmo, y se autoevalúa; el curso ofrece módulos de consulta y herramientas de seguimiento.',
  dimensions: {
    practice: 0.6, authenticity: 0.55, problemFirst: 0.3, guidance: 0.2, reflection: 0.7, priorKnowledge: 0.5,
    evidence: 0.5, inquiry: 0.65, conceptualDepth: 0.55, selfRegulation: 0.95, interactivity: 0.55,
  },
  votes: {
    'module.opening': { value: 'learning_contract', weight: 0.95, ruleId: 'auto.module.contract', rationale: 'El módulo abre con metas y un autodiagnóstico para que el participante elija su ruta.' },
    'module.closing': { value: 'self_assessment', weight: 0.9, ruleId: 'auto.module.self_assessment', rationale: 'El módulo cierra con una autoevaluación contra las metas propias.' },
    'objectives.style': { value: 'self_directed_goal', weight: 0.85, ruleId: 'auto.objectives.goals', rationale: 'Los objetivos se presentan como metas que el participante puede planificar y verificar.' },
    'content.type': { value: 'modular_reference', weight: 0.85, ruleId: 'auto.content.modular', rationale: 'El contenido se organiza en bloques autocontenidos de consulta.' },
    'video.style': { value: 'micro_lecture', weight: 0.85, ruleId: 'auto.video.micro', rationale: 'Videos breves y autónomos, para ver cuando se necesiten.' },
    'video.policy': { value: 'keep', weight: 0.4, ruleId: 'auto.video.keep', rationale: 'Los videos quedan donde el docente los puso.' },
    'video.interactions': { value: 'self_check', weight: 0.85, ruleId: 'auto.video.self_check', rationale: 'Las pausas del video son autocomprobaciones opcionales.' },
    'activity.intent': { value: 'self_check', weight: 0.85, ruleId: 'auto.activity.self_check', rationale: 'La práctica es autocomprobación con clave de respuestas.' },
    'activity.policy': { value: 'keep', weight: 0.4, ruleId: 'auto.activity.keep', rationale: 'Las actividades quedan como las configuró el docente.' },
    'assessment.strategy': { value: 'self_assessment', weight: 0.85, ruleId: 'auto.assessment.self', rationale: 'La evaluación combina autoevaluación con una verificación final.' },
    'assessment.examStyle': { value: 'self_check_bank', weight: 0.8, ruleId: 'auto.exam.self_check', rationale: 'Las evaluaciones de módulo funcionan como banco de autocomprobación.' },
    'assessment.finalExamStyle': { value: 'self_assessment_plus_test', weight: 0.85, ruleId: 'auto.final.self_plus_test', rationale: 'La evaluación final combina una autoevaluación con una prueba objetiva.' },
    'feedback.mode': { value: 'self_check_keys', weight: 0.85, ruleId: 'auto.feedback.keys', rationale: 'La retroalimentación entrega claves para que el participante se corrija solo.' },
    'feedback.timing': { value: 'immediate', weight: 0.8, ruleId: 'auto.feedback.immediate', rationale: 'Sin docente al lado, la retroalimentación tiene que ser inmediata.' },
    'scenarios.type': { value: 'self_selected_case', weight: 0.6, ruleId: 'auto.scenarios.self_selected', rationale: 'Los casos invitan a aplicar lo aprendido a la situación propia del participante.' },
    'reviewCards.policy': { value: 'enable', weight: 0.8, ruleId: 'auto.review.enable', rationale: 'Repaso a demanda: el participante decide cuándo consolidar.' },
  },
  lists: {
    'activity.preferredTypes': { items: ['questionset', 'blanks', 'dragtext', 'branchingscenario'], weight: 0.8, ruleId: 'auto.activity.types', rationale: 'Autocomprobaciones rápidas antes que escenarios largos.' },
    resources: { items: ['learning_plan', 'self_assessment_rubric', 'further_reading', 'review_cards'], weight: 0.75, ruleId: 'auto.resources', rationale: 'Plan de aprendizaje, rúbrica de autoevaluación y lecturas de ampliación.' },
  },
  sequence: ['learning_goals', 'self_diagnosis', 'learning_path', 'modular_content', 'self_paced_practice', 'self_assessment', 'reflection_plan'],
  signatureSteps: [{ step: 'learning_goals', at: 'start' }, { step: 'self_assessment', at: 'end' }],
  objectiveVerbs: ['planificar', 'autoevaluar', 'seleccionar', 'organizar', 'aplicar', 'monitorear'],
  affinity: {
    learningModes: { concepts: 0.5, problems: 0.45, projects: 0.6, practice: 0.55, inquiry: 0.9, collaborative: 0.2, real_application: 0.6 },
    experienceTypes: { autonomous: 1, teacher_guided: 0.1, interactive_collaborative: 0.3, practice_experimentation: 0.5, challenges: 0.5 },
    assessmentMethods: { quizzes: 0.55, practical_exercises: 0.5, cases: 0.45, projects: 0.65, products_evidence: 0.6, self_reflection: 0.95, peer: 0.3 },
    priorKnowledge: { none: 0.2, basic: 0.45, intermediate: 0.8, advanced: 1 },
    experience: { none: 0.2, some: 0.65, extensive: 1 },
    ageGroups: { children: 0.1, teens: 0.35, adults: 0.9, mixed: 0.5 },
    outcomes: { know: 0.55, do: 0.55, competencies: 0.6 },
  },
};

export const BUILTIN_APPROACHES: readonly PedagogicalApproachDefinition[] = Object.freeze([
  APPROACH_COMPETENCIAS,
  APPROACH_PROBLEMAS,
  APPROACH_EXPERIENCIAL,
  APPROACH_SIGNIFICATIVO,
  APPROACH_AUTODIRIGIDO,
]);

let defaultRegistry: PedagogicalApproachRegistry | null = null;

/** Registro de los 5 enfoques iniciales (se construye una vez y queda congelado). */
export function defaultApproachRegistry(): PedagogicalApproachRegistry {
  if (!defaultRegistry) defaultRegistry = new PedagogicalApproachRegistry(BUILTIN_APPROACHES);
  return defaultRegistry;
}
