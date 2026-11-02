import { parseInstitutionalCuts, requestedSplit, resolveTotalHours } from './answers';
import {
  BLOOM, MC_LIMITS, MicrocurriculumAnswers, MicrocurriculumIssue, MicrocurriculumV1, MODALITY_LABEL, RegenSection, competenciesRequired, terminologyFor,
} from './microcurriculum.types';

/**
 * r81 · Prompt del microcurrículo (el producto): una llamada con herramienta FORZADA `emit_microcurriculum`
 * (`tool_choice: { type: 'tool' }`), sin prosa. El system fija el oficio (diseño curricular, verbos observables,
 * coherencia horas/evaluación, respeto literal del docente); el mensaje del usuario lleva la ficha del docente y las
 * restricciones YA calculadas (horas exactas, reparto, unidades, cortes) para que el modelo no tenga que adivinarlas.
 * La identificación, el total de horas y la procedencia NO los emite el modelo: los pone el backend (literal).
 */

export const MICROCURRICULUM_TOOL_NAME = 'emit_microcurriculum';
export const MICROCURRICULUM_PROMPT_VERSION = 1 as const;

const S = (description: string) => ({ type: 'string', description });
const SL = (description: string, minItems?: number, maxItems?: number) => ({
  type: 'array', description, items: { type: 'string' }, ...(minItems !== undefined ? { minItems } : {}), ...(maxItems !== undefined ? { maxItems } : {}),
});

const OUTCOMES_SCHEMA = {
  type: 'array',
  minItems: MC_LIMITS.outcomesMin,
  maxItems: MC_LIMITS.outcomesMax,
  description: 'Resultados de aprendizaje (o desempeños en colegio), del más básico al más complejo.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'text', 'verb', 'bloom', 'condition', 'criterion'],
    properties: {
      id: S('RA1, RA2… consecutivos.'),
      text: S('Enunciado completo: verbo observable en infinitivo + objeto + condición + criterio de calidad.'),
      verb: S('El verbo observable del enunciado, en infinitivo y en minúsculas (p. ej. «analizar»).'),
      bloom: { type: 'string', enum: [...BLOOM], description: 'Nivel de la taxonomía de Bloom revisada que corresponde al verbo.' },
      condition: S('Condición o contexto de desempeño tomada del enunciado (con qué, en qué situación).'),
      criterion: S('Criterio de calidad verificable tomado del enunciado (cómo se sabe que está bien hecho).'),
    },
  },
};

const UNITS_SCHEMA = {
  type: 'array',
  minItems: MC_LIMITS.unitCountMin,
  maxItems: MC_LIMITS.unitCountMax,
  description: 'Unidades temáticas secuenciadas de menor a mayor complejidad.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'title', 'contents', 'outcomeIds', 'hours', 'weeks', 'strategy', 'mainActivity'],
    properties: {
      id: S('U1, U2… consecutivos.'),
      title: S('Título de la unidad (claro, sin numeración).'),
      contents: SL('Contenidos concretos de la unidad (3 a 8), cada uno una frase nominal breve.', 1, MC_LIMITS.contentsPerUnitMax),
      outcomeIds: SL('Ids de los resultados (RA…) que la unidad desarrolla.', 1, 8),
      hours: {
        type: 'object',
        additionalProperties: false,
        required: ['contact', 'practice', 'autonomous'],
        properties: {
          contact: { type: 'number', description: 'Horas de trabajo con el docente (múltiplo de 0,5).' },
          practice: { type: 'number', description: 'Horas de práctica (múltiplo de 0,5).' },
          autonomous: { type: 'number', description: 'Horas de trabajo autónomo (múltiplo de 0,5).' },
        },
      },
      weeks: {
        anyOf: [
          { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'integer' }, to: { type: 'integer' } } },
          { type: 'null' },
        ],
        description: 'Semanas que ocupa la unidad (consecutivas) o null si no hay calendario en semanas.',
      },
      strategy: S('Estrategia didáctica principal de la unidad (una de las elegidas por el docente, aplicada a este contenido).'),
      mainActivity: S('Actividad central concreta que realizan los estudiantes en la unidad (qué producen).'),
    },
  },
};

const EVALUATION_SCHEMA = {
  type: 'array',
  minItems: MC_LIMITS.evaluationMin,
  maxItems: MC_LIMITS.evaluationMax,
  description: 'Momentos de evaluación en orden cronológico. Los porcentajes suman exactamente 100.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'percent', 'outcomeIds', 'week', 'evidence'],
    properties: {
      name: S('Nombre del momento o instrumento (p. ej. «Estudio de caso: diagnóstico financiero»).'),
      percent: { type: 'number', description: 'Peso en la nota final (entero).' },
      outcomeIds: SL('Ids de los resultados (RA…) que evalúa.', 1, 8),
      week: { type: ['integer', 'null'], description: 'Semana en que se aplica, o null si no hay calendario en semanas.' },
      evidence: S('Evidencia concreta que entrega el estudiante y cómo se valora (rúbrica, lista de chequeo…).'),
    },
  },
};

/** Esquema completo de la herramienta (todo el cuerpo del microcurrículo). */
export const MICROCURRICULUM_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'justification', 'learnerProfile', 'priorKnowledge', 'generalObjective', 'specificObjectives', 'outcomes', 'competencies', 'units', 'methodology', 'evaluation', 'resources', 'bibliography'],
  properties: {
    description: S('Descripción del curso en 1 o 2 párrafos: de qué trata, cómo se desarrolla y qué logra quien lo cursa.'),
    justification: S('Justificación: el problema o necesidad que resuelve y por qué importa en el programa y en el contexto.'),
    learnerProfile: S('Perfil de los estudiantes (a partir de lo que dijo el docente, sin inventar datos).'),
    priorKnowledge: S('Conocimientos previos o prerrequisitos (los del docente; si no los dio, los mínimos razonables).'),
    generalObjective: S('Objetivo general: una sola frase con verbo en infinitivo.'),
    specificObjectives: SL('Objetivos específicos (2 a 6), con verbo en infinitivo.', MC_LIMITS.specificObjectivesMin, MC_LIMITS.specificObjectivesMax),
    outcomes: OUTCOMES_SCHEMA,
    competencies: {
      type: 'array',
      maxItems: MC_LIMITS.competenciesMax,
      description: 'Competencias (CO1, CO2…). Lista vacía si no corresponden.',
      items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: S('CO1, CO2…'), text: S('Enunciado de la competencia.') } },
    },
    units: UNITS_SCHEMA,
    methodology: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'strategies'],
      properties: {
        text: S('Metodología: un párrafo que explica cómo se combinan las estrategias y el rol del docente y del estudiante.'),
        strategies: SL('Estrategias didácticas usadas (las elegidas por el docente).'),
      },
    },
    evaluation: EVALUATION_SCHEMA,
    resources: SL('Recursos didácticos y tecnológicos (los del docente primero).', 0, MC_LIMITS.resourcesMax),
    bibliography: {
      type: 'array',
      maxItems: MC_LIMITS.bibliographyMax,
      description: 'Bibliografía: primero la obligatoria del docente (literal, origin «docente»); luego sugeridas (origin «sugerida»).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'origin'],
        properties: {
          text: S('Referencia. Sugeridas: solo obras reales y conocidas, en formato APA, SIN ISBN, DOI ni URL.'),
          origin: { type: 'string', enum: ['docente', 'sugerida'] },
        },
      },
    },
  },
};

export interface McTool { name: string; description: string; input_schema: Record<string, unknown> }

export function microcurriculumTool(): McTool {
  return {
    name: MICROCURRICULUM_TOOL_NAME,
    description: 'Entrega el microcurrículo completo, estructurado. Es la ÚNICA forma de responder.',
    input_schema: MICROCURRICULUM_INPUT_SCHEMA,
  };
}

const SECTION_SCHEMA: Record<RegenSection, unknown> = { outcomes: OUTCOMES_SCHEMA, units: UNITS_SCHEMA, evaluation: EVALUATION_SCHEMA };

/** Herramienta de regeneración de UNA sección (mismo nombre; solo esa clave). */
export function sectionTool(section: RegenSection): McTool {
  return {
    name: MICROCURRICULUM_TOOL_NAME,
    description: `Entrega SOLO la sección «${section}» del microcurrículo. Es la ÚNICA forma de responder.`,
    input_schema: { type: 'object', additionalProperties: false, required: [section], properties: { [section]: SECTION_SCHEMA[section] } },
  };
}

// ── System ────────────────────────────────────────────────────────────────────────────────────────────────

export function buildSystemPrompt(answers: MicrocurriculumAnswers): string {
  const type = answers.identification?.institutionType;
  const t = terminologyFor(type);
  const contextRules: Record<string, string> = {
    universidad: '- Universidad: lenguaje académico formal; resultados de aprendizaje alineados con el perfil de egreso; incluye 2 a 4 competencias (genéricas y específicas); el trabajo autónomo suele ser al menos el doble del trabajo con el docente cuando se habla de créditos.',
    tecnica: '- Institución técnica o tecnológica: enfoque en saber hacer y en desempeños de ocupación; competencias técnicas y transversales (2 a 4); prioriza práctica y laboratorio.',
    etdh: '- SENA / Educación para el Trabajo y el Desarrollo Humano: llama «aprendices» a los estudiantes; resultados de aprendizaje y competencias laborales en el estilo de las normas de competencia (2 a 4 competencias); la práctica y la evidencia de desempeño pesan más que la teoría.',
    colegio: '- Colegio: la sección de resultados se titula «Desempeños», pero cada desempeño se redacta IGUAL que un resultado: empieza con el verbo observable en infinitivo (p. ej. «Clasificar los factores…»), nunca con «El estudiante…»; lenguaje claro para el grado indicado; actividades adecuadas a la edad; competencias solo si el docente las dio.',
    corporativa: '- Formación corporativa: llama «participantes» a los estudiantes; orientación a resultados en el puesto de trabajo, casos y retos del negocio; evaluación aplicada (productos, simulaciones), no académica; competencias solo si el docente las dio.',
  };
  return [
    'Eres un diseñador curricular senior de Latinoamérica, experto en diseño por resultados de aprendizaje, alineamiento constructivo y taxonomía de Bloom revisada.',
    `Tu tarea: redactar el MICROCURRÍCULO de un curso (${t.institutionLabel}) a partir de las respuestas de un docente, listo para presentarlo y aprobarlo en su institución.`,
    'Respondes SIEMPRE y SOLO llamando a la herramienta `emit_microcurriculum`. Nada de prosa fuera de la herramienta.',
    '',
    'IDIOMA Y ESTILO',
    '- Español latinoamericano neutro, formal y claro. Sin voseo, sin la segunda persona del plural de España y sin regionalismos. Sin emojis.',
    '- Frases concretas y propias de ESTE curso: nada genérico que sirva para cualquier materia.',
    '',
    'RESPETO AL DOCENTE (obligatorio)',
    '- Lo que el docente escribió es la autoridad: no lo contradigas, no lo reemplaces y no lo «mejores» cambiando su sentido.',
    '- La bibliografía obligatoria del docente va COPIADA LITERAL, carácter por carácter, con origin «docente», al inicio de la lista.',
    '- Si el docente dio competencias, úsalas con su redacción (puedes separarlas en ítems CO1, CO2… sin cambiar las palabras).',
    '- Si un dato no se dio, propón lo más razonable para el contexto; nunca inventes datos institucionales (nombres de normas, acuerdos, códigos).',
    '',
    `${t.outcomesLabel.toUpperCase()} (${MC_LIMITS.outcomesMin} a ${MC_LIMITS.outcomesMax})`,
    '- Fórmula: VERBO OBSERVABLE en infinitivo + objeto de aprendizaje + CONDICIÓN (con qué recursos, en qué situación) + CRITERIO de calidad verificable.',
    '  Ejemplo: «Elaborar el flujo de caja proyectado de una microempresa, a partir de sus estados financieros reales, con un error menor al 5 % frente a la plantilla de verificación».',
    '- Prohibidos como verbo: comprender, conocer, entender, saber, aprender, apreciar, familiarizarse, valorar, interiorizar, asimilar, reflexionar, tomar conciencia. Usa verbos que se puedan evidenciar: identificar, explicar, calcular, aplicar, analizar, comparar, diagnosticar, evaluar, argumentar, diseñar, elaborar, formular, construir…',
    '- `bloom` es el nivel del verbo (recordar, comprender, aplicar, analizar, evaluar, crear). Progresión: pocos de recordar/comprender, la mayoría en aplicar/analizar, y al menos uno en evaluar o crear cuando el nivel lo permite.',
    '- Los resultados cubren TODO lo que el docente dijo que el estudiante debe saber hacer al terminar.',
    '- `condition` y `criterion` son las partes del enunciado que expresan la condición y el criterio (no textos nuevos).',
    '',
    'UNIDADES',
    '- Secuencia de menor a mayor complejidad: fundamentos → aplicación → integración/proyecto. Cada unidad con 3 a 8 contenidos concretos.',
    '- Cada tema obligatorio del docente aparece con SUS MISMAS PALABRAS en el título o en un contenido de alguna unidad. Los temas excluidos no aparecen en ninguna parte.',
    '- Cada resultado se trabaja en al menos una unidad (outcomeIds) y ninguna unidad referencia un id que no exista.',
    '- HORAS: la suma de contact + practice + autonomous de TODAS las unidades es EXACTAMENTE el total indicado; usa múltiplos de 0,5. Si hay reparto exigido por tipo, la suma de cada tipo es exactamente la exigida. Haz la suma antes de responder.',
    '- Reparte las horas en proporción a la complejidad y extensión de cada unidad (no en partes iguales por comodidad).',
    '- `strategy` sale de las estrategias que eligió el docente; `mainActivity` es lo que el estudiante produce en la unidad.',
    '',
    'EVALUACIÓN',
    '- Momentos en orden cronológico; porcentajes enteros que suman EXACTAMENTE 100. Cada resultado se evalúa en al menos un momento.',
    '- Si hay cortes institucionales (p. ej. 30/30/40), los momentos CONSECUTIVOS de cada corte suman exactamente el porcentaje del corte, en ese orden.',
    '- Si el docente exigió algo (p. ej. «examen final obligatorio»), inclúyelo tal cual.',
    '- La evidencia es concreta (producto, desempeño o conocimiento) e indica el instrumento (rúbrica, lista de chequeo, prueba escrita…).',
    '',
    'BIBLIOGRAFÍA Y RECURSOS',
    '- Sugeridas: 3 a 6 obras reales y reconocidas del área, en formato APA, origin «sugerida». NUNCA inventes ISBN, DOI, URL, ediciones ni páginas. Si no estás seguro de que una obra existe, no la incluyas.',
    '- Recursos: primero los que dio el docente; luego los necesarios para las actividades.',
    '',
    'CONTEXTO DE LA INSTITUCIÓN',
    contextRules[type || 'universidad'] || contextRules.universidad,
    `- Términos: «${t.learnersPlural}» para los estudiantes; la sección de resultados se llama «${t.outcomesLabel}».`,
    '',
    'Antes de llamar a la herramienta verifica: sumas de horas (total y por tipo), suma de porcentajes = 100, cortes, cobertura de cada RA en unidades y evaluación, temas obligatorios presentes, temas excluidos ausentes, verbos observables, bibliografía del docente literal.',
  ].join('\n');
}

// ── Ficha del docente ───────────────────────────────────────────────────────────────────────────────────

const line = (label: string, v: unknown) => (v === undefined || v === null || v === '' ? `- ${label}: (no lo indicó — propón lo adecuado)` : `- ${label}: ${String(v)}`);
const bullets = (xs: string[] | undefined) => (xs && xs.length ? xs.map((x) => `  • ${x}`).join('\n') : '  (ninguno)');

/** Restricciones duras ya calculadas (el modelo no tiene que deducirlas). */
export function constraintsBlock(answers: MicrocurriculumAnswers): string {
  const total = resolveTotalHours(answers.time);
  const split = requestedSplit(answers.time);
  const kinds: string[] = [];
  if (split.contact !== undefined) kinds.push(`trabajo con el docente (contact) = ${split.contact} h`);
  if (split.practice !== undefined) kinds.push(`práctica (practice) = ${split.practice} h`);
  if (split.autonomous !== undefined) kinds.push(`trabajo autónomo (autonomous) = ${split.autonomous} h`);
  const units = answers.contents?.unitCount;
  const cuts = parseInstitutionalCuts(answers.methodology?.institutionalEvaluation);
  const weeks = answers.time?.weeks;
  const t = terminologyFor(answers.identification?.institutionType);
  const out = [
    'RESTRICCIONES DURAS (el validador las comprueba una por una)',
    `- Total de horas del curso: EXACTAMENTE ${total} h (suma de contact + practice + autonomous de todas las unidades).`,
    kinds.length ? `- Reparto exigido por el docente: ${kinds.join('; ')}.${kinds.length < 3 ? ' El resto de las horas, en los otros tipos, según el contexto.' : ''}` : '- Reparto por tipo: no exigido; propón uno coherente con el tipo de institución y la modalidad.',
    typeof units === 'number' ? `- Número de unidades: EXACTAMENTE ${units}.` : `- Número de unidades: entre ${MC_LIMITS.defaultUnitsMin} y ${MC_LIMITS.defaultUnitsMax}, según la extensión.`,
    `- ${t.outcomesLabel}: entre ${MC_LIMITS.outcomesMin} y ${MC_LIMITS.outcomesMax}, ids RA1…; objetivos específicos: ${MC_LIMITS.specificObjectivesMin} a ${MC_LIMITS.specificObjectivesMax}.`,
    competenciesRequired(answers) ? '- Competencias: obligatorias (al menos una).' : '- Competencias: lista vacía (no corresponden para este tipo de institución y el docente no las dio).',
    cuts ? `- Cortes institucionales: ${cuts.join(' / ')}. Ordena la evaluación cronológicamente y agrupa momentos consecutivos que sumen exactamente ${cuts.join(', luego ')}.` : '- Evaluación: porcentajes enteros que suman 100.',
    typeof weeks === 'number' ? `- Calendario: ${weeks} semanas; asigna a cada unidad semanas consecutivas que cubran de la 1 a la ${weeks}, y a cada evaluación su semana.` : '- Calendario en semanas: no definido; usa weeks = null y week = null salvo que el calendario del docente indique semanas.',
  ];
  return out.join('\n');
}

export function teacherSheet(answers: MicrocurriculumAnswers): string {
  const id = answers.identification || {};
  const le = answers.learners || {};
  const pu = answers.purpose || {};
  const ti = answers.time || {};
  const co = answers.contents || {};
  const me = answers.methodology || {};
  const re = answers.references || {};
  const t = terminologyFor(id.institutionType);
  const intensity = ti.mode === 'credits' ? `${ti.credits} créditos (× 48 h)` : ti.mode === 'weekly' ? `${ti.weeks} semanas × ${ti.hoursPerWeek} h/semana` : `${ti.totalHours} h`;
  return [
    'FICHA DEL DOCENTE (respuestas del cuestionario; lo literal se respeta)',
    '',
    '1. Identificación',
    line('Nombre del curso', id.courseName),
    line('Tipo de institución', t.institutionLabel),
    line('Programa', id.program),
    line('Semestre o grado', id.term),
    line('Modalidad', id.modality ? MODALITY_LABEL[id.modality] : undefined),
    line('Área', id.area),
    '',
    `2. ${t.learnersPlural[0].toUpperCase()}${t.learnersPlural.slice(1)}`,
    line('Perfil', le.profile),
    line('Conocimientos previos', le.priorKnowledge),
    line('Contexto / región', le.context),
    line('Necesidades especiales', le.specialNeeds),
    '',
    '3. Propósito',
    line('Problema o necesidad que resuelve', pu.need),
    line('Qué debe saber hacer al terminar', pu.expectedAbilities),
    line('Competencias institucionales o del perfil de egreso', pu.competencies),
    '',
    '4. Tiempo',
    line('Intensidad', intensity),
    line('Calendario', ti.calendar),
    '',
    '5. Contenidos',
    '- Temas obligatorios (cada uno debe aparecer con estas palabras en una unidad):',
    bullets(co.requiredTopics),
    '- Temas a excluir (no deben aparecer en ninguna parte):',
    bullets(co.excludedTopics),
    '',
    '6. Metodología y evaluación',
    line('Estrategias elegidas', (me.strategies || []).join(', ')),
    line('Evaluación institucional exigida', me.institutionalEvaluation),
    line('Recursos disponibles', me.resources),
    '',
    '7. Referencias y cierre',
    '- Bibliografía obligatoria (copiar LITERAL, origin «docente»):',
    bullets(re.bibliography),
    line('Docente / autor', re.author),
    line('Observaciones del docente', re.notes),
  ].join('\n');
}

function issuesBlock(issues: MicrocurriculumIssue[]): string {
  return [
    'TU PROPUESTA ANTERIOR NO PASÓ EL VALIDADOR. Corrige TODOS estos problemas sin introducir otros:',
    ...issues.filter((i) => i.severity === 'error').slice(0, 30).map((i) => `- [${i.code}] ${i.message}`),
  ].join('\n');
}

/** Mensaje del usuario para generar el microcurrículo completo (con la lista de errores en el reintento). */
export function buildUserPrompt(answers: MicrocurriculumAnswers, retry?: { issues: MicrocurriculumIssue[] } | null): string {
  return [
    teacherSheet(answers),
    '',
    constraintsBlock(answers),
    ...(retry && retry.issues.length ? ['', issuesBlock(retry.issues)] : []),
    '',
    'Entrega ahora el microcurrículo COMPLETO llamando a `emit_microcurriculum`.',
  ].join('\n');
}

const SECTION_LABEL: Record<RegenSection, string> = { outcomes: 'resultados de aprendizaje', units: 'unidades temáticas', evaluation: 'evaluación' };

/** Mensaje del usuario para regenerar UNA sección; el resto del documento va como contexto FIJO. */
export function buildRegeneratePrompt(answers: MicrocurriculumAnswers, doc: MicrocurriculumV1, section: RegenSection, retry?: { issues: MicrocurriculumIssue[] } | null): string {
  const fixed: Record<string, unknown> = {
    description: doc.description, generalObjective: doc.generalObjective, specificObjectives: doc.specificObjectives,
    outcomes: doc.outcomes, competencies: doc.competencies,
    units: doc.units.map((u) => ({ id: u.id, title: u.title, contents: u.contents, outcomeIds: u.outcomeIds, hours: u.hours, weeks: u.weeks })),
    evaluation: doc.evaluation, methodology: doc.methodology,
  };
  delete fixed[section];
  const rules: Record<RegenSection, string> = {
    outcomes: `- Entrega EXACTAMENTE ${doc.outcomes.length} resultados con los MISMOS ids (${doc.outcomes.map((o) => o.id).join(', ')}): las unidades y la evaluación ya los referencian por id. Mejora su redacción, observabilidad y progresión de Bloom manteniendo lo que cada id trabaja.`,
    units: '- Las unidades referencian SOLO los resultados existentes y cubren todos; respeta horas totales, reparto, número de unidades y temas obligatorios/excluidos de las restricciones.',
    evaluation: '- La evaluación cubre todos los resultados existentes, suma 100 y respeta los cortes institucionales y lo exigido por el docente.',
  };
  return [
    teacherSheet(answers),
    '',
    constraintsBlock(answers),
    '',
    `REGENERA SOLO LA SECCIÓN «${SECTION_LABEL[section]}» (clave \`${section}\`). El resto del microcurrículo es FIJO y se muestra a continuación:`,
    JSON.stringify(fixed),
    '',
    rules[section],
    `- Propón una versión distinta y mejor de la actual sección «${SECTION_LABEL[section]}», coherente con lo fijo.`,
    ...(retry && retry.issues.length ? ['', issuesBlock(retry.issues)] : []),
    '',
    `Entrega ahora SOLO \`${section}\` llamando a \`emit_microcurriculum\`.`,
  ].join('\n');
}
