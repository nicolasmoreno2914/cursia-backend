import { bloomLevelOf } from '../academic-context/bloom';
import { LEARNING_TYPES, LearningType, isOneOf } from './vocabulary';

/**
 * T2 (r57) · Tipo de aprendizaje por capítulo — clasificador DETERMINISTA (sin IA, sin red).
 *
 * Entrada: objetivo, título y descripción del capítulo (lo que el docente ve en la estructura).
 * Salida: uno de LEARNING_TYPES con su justificación (regla ganadora + evidencia: qué palabra, en qué
 * campo) y el nivel del objetivo (Bloom, `academic-context/bloom.ts`). La misma entrada da SIEMPRE el
 * mismo resultado (lo prueba check-learning-plan.js).
 *
 * Algoritmo (versión LEARNING_TYPE_RULES_VERSION; cambiar una lista o un peso = versión nueva, porque
 * el resultado se congela en el Blueprint):
 *  1. Texto plegado: minúsculas, sin tildes (ñ → n), palabras [a-z0-9]. Se quitan las locuciones que no
 *     hablan del contenido («en caso de» no es un caso de estudio).
 *  2. Cada regla tiene pistas: TÉRMINOS del dominio (peso 2) y VERBOS de desempeño (peso 1). Una pista
 *     es una frase exacta («primeros auxilios») o una raíz con `*` («protocol*»). Cuenta una vez por campo.
 *  3. Peso del campo: objetivo 3, título 2, descripción 1 (el objetivo declara la intención; la
 *     descripción narra).
 *  4. Gana el tipo con más puntos. Empate → el más específico según LEARNING_TYPE_PRIORITY (un
 *     protocolo o una norma pesan más que «conceptual», que es el tipo por defecto).
 *  5. Sin ninguna pista → `conceptual` con la regla `lt.default` (se muestra como «sin evidencia»: el
 *     docente puede fijarlo).
 * El docente puede fijar el tipo de un capítulo (override): manda sobre las reglas y la sugerencia de
 * las reglas queda a la vista (`suggested`).
 */

export const LEARNING_TYPE_RULES_VERSION = 1;

/** Desempate (más específico primero). */
export const LEARNING_TYPE_PRIORITY: readonly LearningType[] = Object.freeze([
  'protocolo', 'normativo_etico', 'comunicacion', 'decision_caso', 'procedimental', 'conceptual',
]);

export const LEARNING_TYPE_FIELD_WEIGHTS = Object.freeze({ objective: 3, title: 2, description: 1 });
export const LEARNING_TYPE_CUE_WEIGHTS = Object.freeze({ term: 2, verb: 1 });

export type LearningTypeField = keyof typeof LEARNING_TYPE_FIELD_WEIGHTS;
export type LearningTypeCueKind = keyof typeof LEARNING_TYPE_CUE_WEIGHTS;

export interface LearningTypeRule {
  id: string;
  type: LearningType;
  kind: LearningTypeCueKind;
  cues: readonly string[];
}

/** Locuciones que se eliminan antes de buscar pistas (no describen el contenido del capítulo). */
export const LEARNING_TYPE_STOP_PHRASES: readonly string[] = Object.freeze(['en caso de', 'en todo caso', 'en este caso', 'en cada caso', 'que es un caso']);

function rule(type: LearningType, kind: LearningTypeCueKind, cues: string[]): LearningTypeRule {
  return Object.freeze({ id: `lt.${type}.${kind}`, type, kind, cues: Object.freeze(cues) });
}

/** Reglas v1 (pistas plegadas: sin tildes, ñ → n). */
export const LEARNING_TYPE_RULES: readonly LearningTypeRule[] = Object.freeze([
  rule('protocolo', 'term', [
    'protocol*', 'bioseguridad', 'primeros auxilios', 'rcp', 'reanimacion', 'emergencia*', 'evacuacion', 'triage', 'triaje',
    'lista de chequeo', 'lista de verificacion', 'checklist', 'ruta de atencion', 'rutas de atencion', 'cadena de custodia',
    'aislamiento', 'esterilizacion', 'desinfeccion', 'signos vitales', 'codigo azul', 'plan de contingencia', 'plan de emergencia',
    'procedimiento operativo estandar', 'segun el procedimiento', 'procedimiento establecido', 'elementos de proteccion personal', 'epp', 'manejo de residuos', 'contencion de derrames',
  ]),
  rule('protocolo', 'verb', ['activar', 'activa', 'notificar', 'notifica', 'evacuar', 'reanimar', 'estabilizar', 'inmovilizar', 'desinfectar', 'esterilizar', 'aislar']),
  rule('normativo_etico', 'term', [
    'ley', 'leyes', 'decreto*', 'norma', 'normas', 'normativ*', 'normatividad', 'reglament*', 'marco legal', 'marco normativo', 'legal', 'legales',
    'legislacion', 'juridic*', 'etica', 'etico', 'eticos', 'eticas', 'deontolog*', 'bioetica', 'consentimiento*', 'derecho', 'derechos',
    'deberes', 'obligacion*', 'confidencialidad', 'secreto profesional', 'responsabilidad legal', 'responsabilidad penal', 'sancion*',
    'denuncia*', 'privacidad', 'proteccion de datos', 'habeas data', 'cumplimiento', 'codigo de etica', 'jurisprudencia', 'sentencia*',
    'constitucion', 'dilema*', 'iso', 'ntc',
  ]),
  rule('normativo_etico', 'verb', ['cumplir', 'cumple', 'denunciar', 'garantizar', 'respetar', 'sancionar']),
  rule('comunicacion', 'term', [
    'comunicacion', 'entrevista*', 'dialogo*', 'conversacion*', 'escucha activa', 'asertiv*', 'empatia', 'atencion al cliente',
    'servicio al cliente', 'relacion con el cliente', 'negociacion', 'mediacion', 'conflicto*', 'primer contacto', 'contencion emocional',
    'lenguaje no verbal', 'trabajo en equipo', 'oratoria', 'presentacion oral', 'quejas y reclamos', 'malas noticias',
  ]),
  rule('comunicacion', 'verb', ['comunic*', 'dialogar', 'conversar', 'escuchar', 'negociar', 'persuadir', 'entrevistar', 'orientar', 'acompanar', 'mediar', 'informar']),
  rule('decision_caso', 'term', [
    'decision*', 'caso', 'casos', 'situacion*', 'escenario*', 'problema*', 'alternativa*', 'riesgo*', 'diagnostico*', 'simulacion*',
    'toma de decisiones', 'estudio de caso', 'resolucion de problemas', 'incidente*', 'criterio de decision',
  ]),
  rule('decision_caso', 'verb', ['decidir', 'decide', 'deciden', 'prioriz*', 'diagnostic*', 'resolver', 'resuelve', 'seleccionar', 'selecciona', 'elegir', 'elige', 'juzgar', 'evaluar', 'evalua', 'solucionar', 'valorar', 'simular']),
  rule('procedimental', 'term', [
    'procedimiento*', 'paso a paso', 'pasos', 'tecnica*', 'formula*', 'herramienta*', 'software', 'hoja de calculo', 'hojas de calculo',
    'plantilla*', 'calculo*', 'configuracion', 'instalacion', 'documento*', 'informe*', 'presupuesto*', 'inventario*', 'metodo*', 'normas apa',
    'tabla*', 'grafico*', 'funciones', 'macros', 'base de datos', 'bases de datos', 'circuito*', 'receta*',
  ]),
  rule('procedimental', 'verb', [
    'calcul*', 'elabor*', 'realizar', 'realiza', 'ejecut*', 'registrar', 'registra', 'configur*', 'instal*', 'operar', 'opera', 'prepar*',
    'liquid*', 'program*', 'construir', 'construye', 'montar', 'ensamblar', 'medir', 'mide', 'redact*', 'diligenci*', 'aplicar', 'aplica',
    'usar', 'utilizar', 'emplear', 'manejar', 'insertar', 'formatear', 'disenar', 'disena', 'crear', 'crea', 'implementar', 'producir',
  ]),
  rule('conceptual', 'term', [
    'concepto*', 'fundament*', 'principio*', 'teori*', 'introduccion', 'nocion*', 'historia', 'evolucion', 'tipos de', 'caracteristicas',
    'elementos', 'marco conceptual', 'generalidades', 'que es', 'definicion*', 'clasificacion',
  ]),
  rule('conceptual', 'verb', [
    'comprend*', 'entend*', 'explic*', 'describ*', 'definir', 'define', 'identific*', 'reconoc*', 'conocer', 'conoce', 'diferenci*',
    'distingu*', 'clasific*', 'compar*', 'relacion*', 'interpret*', 'caracteriz*', 'analiz*', 'ejemplific*', 'resumir',
  ]),
]);

export interface LearningTypeEvidence {
  field: LearningTypeField;
  cue: string;
  kind: LearningTypeCueKind;
}

export interface LearningTypeClassification {
  type: LearningType;
  ruleId: string;
  /** Nivel del objetivo (Bloom: remember … create) o null si su verbo no está en el léxico. */
  level: string | null;
  evidence: LearningTypeEvidence[];
  /** Puntos por tipo (solo tipos con puntos, en el orden del vocabulario). */
  scores: Partial<Record<LearningType, number>>;
}

/** Diseño congelado en `chapter.design.learningType` (Blueprint). */
export interface ChapterLearningTypeDesign {
  type: LearningType;
  source: 'rules' | 'override';
  rulesVersion: number;
  ruleId: string;
  level: string | null;
  evidence: LearningTypeEvidence[];
  /** Solo con override distinto de lo que sugerían las reglas: el tipo que sugerían. */
  suggested?: LearningType;
}

export const LEARNING_TYPE_EVIDENCE_MAX = 5;

function fold(s: string): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function words(s: string): string[] {
  let t = ` ${fold(s)} `;
  for (const p of LEARNING_TYPE_STOP_PHRASES) t = t.split(` ${p} `).join(' ');
  return t.split(' ').filter(Boolean);
}

function cueMatches(cue: string, ws: string[]): boolean {
  const parts = cue.split(' ');
  for (let i = 0; i + parts.length <= ws.length; i++) {
    let ok = true;
    for (let j = 0; j < parts.length && ok; j++) {
      const p = parts[j];
      const w = ws[i + j];
      ok = p.endsWith('*') ? w.startsWith(p.slice(0, -1)) : w === p;
    }
    if (ok) return true;
  }
  return false;
}

/** Clasifica un capítulo. Pura y determinista. */
export function classifyLearningType(ch: { objective?: string | null; title?: string | null; description?: string | null }): LearningTypeClassification {
  const fields: Array<[LearningTypeField, string]> = [
    ['objective', ch.objective ?? ''],
    ['title', ch.title ?? ''],
    ['description', ch.description ?? ''],
  ];
  const scores = new Map<LearningType, number>();
  const ruleScore = new Map<string, number>();
  const evidence: Array<LearningTypeEvidence & { type: LearningType; points: number; order: number }> = [];
  let order = 0;
  for (const [field, text] of fields) {
    const ws = words(text);
    if (!ws.length) continue;
    for (const r of LEARNING_TYPE_RULES) {
      for (const cue of r.cues) {
        if (!cueMatches(cue, ws)) continue;
        const points = LEARNING_TYPE_FIELD_WEIGHTS[field] * LEARNING_TYPE_CUE_WEIGHTS[r.kind];
        scores.set(r.type, (scores.get(r.type) ?? 0) + points);
        ruleScore.set(r.id, (ruleScore.get(r.id) ?? 0) + points);
        evidence.push({ field, cue, kind: r.kind, type: r.type, points, order: order++ });
      }
    }
  }
  const level = bloomLevelOf(ch.objective ?? '') ?? bloomLevelOf(ch.title ?? '');
  const outScores: Partial<Record<LearningType, number>> = {};
  for (const t of LEARNING_TYPES) if (scores.has(t)) outScores[t] = scores.get(t)!;
  if (!scores.size) return { type: 'conceptual', ruleId: 'lt.default', level, evidence: [], scores: outScores };
  let best: LearningType | null = null;
  for (const t of LEARNING_TYPE_PRIORITY) {
    const s = scores.get(t) ?? 0;
    if (s > 0 && (best === null || s > (scores.get(best) ?? 0))) best = t;
  }
  const type = best as LearningType;
  const term = ruleScore.get(`lt.${type}.term`) ?? 0;
  const verb = ruleScore.get(`lt.${type}.verb`) ?? 0;
  const ruleId = term >= verb ? `lt.${type}.term` : `lt.${type}.verb`;
  const ev = evidence
    .filter((e) => e.type === type)
    .sort((a, b) => b.points - a.points || a.order - b.order)
    .slice(0, LEARNING_TYPE_EVIDENCE_MAX)
    .map((e) => ({ field: e.field, cue: e.cue, kind: e.kind }));
  return { type, ruleId, level, evidence: ev, scores: outScores };
}

/** Tipo del capítulo con el override del docente (si lo hay). */
export function resolveChapterLearningType(
  ch: { objective?: string | null; title?: string | null; description?: string | null },
  override?: string | null,
): ChapterLearningTypeDesign {
  const c = classifyLearningType(ch);
  if (override !== undefined && override !== null) {
    if (!isOneOf(LEARNING_TYPES, override)) throw new Error(`LEARNING_TYPE_INVALID: ${JSON.stringify(override)} (permitidos: ${LEARNING_TYPES.join(', ')})`);
    return {
      type: override, source: 'override', rulesVersion: LEARNING_TYPE_RULES_VERSION, ruleId: 'lt.override', level: c.level, evidence: [],
      ...(override !== c.type ? { suggested: c.type } : {}),
    };
  }
  return { type: c.type, source: 'rules', rulesVersion: LEARNING_TYPE_RULES_VERSION, ruleId: c.ruleId, level: c.level, evidence: c.evidence };
}

// ── B · Actividad calificada derivada del tipo de aprendizaje ───────────────

export type LearningPlanH5pType = 'questionset' | 'dragtext' | 'blanks' | 'branchingscenario';

const HIGH_LEVELS = ['apply', 'analyze', 'evaluate', 'create'];

export interface LearningTypeActivityRule {
  id: string;
  /** Niveles Bloom a los que aplica (vacío = cualquiera, incluido null). La primera regla que calza gana. */
  levels: readonly string[];
  /** Tipos H5P en orden de preferencia (solo los del Library Pack del sitio; questionset siempre al final como respaldo). */
  candidates: readonly LearningPlanH5pType[];
  rationale: string;
}

/**
 * Tabla de datos: tipo de aprendizaje (+ nivel del objetivo) → tipos H5P calificados en orden. Reemplaza la
 * rotación por hash y la intención del enfoque cuando el plan está activo. Las reglas de balance de siempre
 * (tope de escenarios ramificados y variedad) solo pueden moverse DENTRO de esta lista: nunca eligen un tipo
 * que no corresponde al tipo de aprendizaje.
 */
export const LEARNING_TYPE_ACTIVITY_RULES: Readonly<Record<LearningType, readonly LearningTypeActivityRule[]>> = Object.freeze({
  conceptual: [
    { id: 'la.conceptual.remember', levels: ['remember'], candidates: ['blanks', 'dragtext', 'questionset'], rationale: 'Objetivo de recordar: recuperar los términos clave (completar) fortalece la memoria.' },
    { id: 'la.conceptual.understand', levels: ['understand'], candidates: ['dragtext', 'questionset', 'blanks'], rationale: 'Objetivo de comprender: relacionar y clasificar conceptos (arrastrar y ordenar).' },
    { id: 'la.conceptual', levels: [], candidates: ['questionset', 'dragtext', 'blanks'], rationale: 'Contenido conceptual: preguntas de aplicación a situaciones cortas para comprobar que el concepto se usa, no solo se repite.' },
  ],
  procedimental: [
    { id: 'la.procedimental.apply', levels: HIGH_LEVELS, candidates: ['questionset', 'dragtext'], rationale: 'Procedimiento de nivel aplicar o superior: ejercicios de aplicación con datos (preguntas situacionales).' },
    { id: 'la.procedimental', levels: [], candidates: ['dragtext', 'questionset'], rationale: 'Procedimiento: ordenar los pasos y completar los criterios críticos (arrastrar y ordenar).' },
  ],
  protocolo: [
    { id: 'la.protocolo', levels: [], candidates: ['dragtext', 'questionset'], rationale: 'Protocolo: el orden de los pasos críticos es lo que se evalúa (arrastrar y ordenar), con la demostración en el video.' },
  ],
  decision_caso: [
    { id: 'la.decision_caso', levels: [], candidates: ['branchingscenario', 'questionset'], rationale: 'Decisión o caso: el estudiante decide y ve las consecuencias (escenario ramificado o, si no está disponible, preguntas de caso).' },
  ],
  comunicacion: [
    { id: 'la.comunicacion', levels: [], candidates: ['branchingscenario', 'questionset'], rationale: 'Comunicación: diálogo con decisiones (escenario ramificado o, si no está disponible, preguntas de juicio situacional).' },
  ],
  normativo_etico: [
    { id: 'la.normativo_etico', levels: [], candidates: ['questionset', 'branchingscenario'], rationale: 'Normativo o ético: casos límite en los que el estudiante aplica la regla y justifica (preguntas de caso con justificación).' },
  ],
});

/** Regla de actividad que aplica a un tipo de aprendizaje y nivel, con los candidatos filtrados por lo disponible. */
export function learningTypeActivityRule(
  type: LearningType,
  level: string | null,
  allowed: readonly string[],
): { ruleId: string; candidates: LearningPlanH5pType[]; rationale: string } {
  const rules = LEARNING_TYPE_ACTIVITY_RULES[type];
  if (!rules) throw new Error(`LEARNING_TYPE_INVALID: ${JSON.stringify(type)}`);
  const r = rules.find((x) => x.levels.length === 0 || (level !== null && x.levels.includes(level)))!;
  const candidates = r.candidates.filter((t) => allowed.includes(t));
  if (!candidates.length) candidates.push('questionset');
  return { ruleId: r.id, candidates: [...candidates], rationale: r.rationale };
}

// ── Etiquetas y textos ──────────────────────────────────────────────────────

export const LEARNING_TYPE_LABELS: Readonly<Record<LearningType, string>> = Object.freeze({
  conceptual: 'Conceptual',
  procedimental: 'Procedimental',
  protocolo: 'Protocolo',
  decision_caso: 'Decisión / caso',
  comunicacion: 'Comunicación',
  normativo_etico: 'Normativo / ético',
});

export const LEARNING_TYPE_SUMMARIES: Readonly<Record<LearningType, string>> = Object.freeze({
  conceptual: 'Definiciones, marcos y relaciones entre ideas.',
  procedimental: 'Técnicas, cálculos y tareas que se ejecutan paso a paso.',
  protocolo: 'Secuencias estandarizadas con pasos críticos que no se pueden omitir.',
  decision_caso: 'Situaciones en las que hay que analizar y decidir.',
  comunicacion: 'Interacción con otras personas: entrevistar, orientar, negociar.',
  normativo_etico: 'Normas, deberes y dilemas que exigen aplicar una regla y justificar.',
});

/** Etiqueta para el docente de la regla y de la evidencia (panel y dry-run). */
export function learningTypeJustification(d: ChapterLearningTypeDesign): string {
  if (d.source === 'override') {
    return `Fijado por el docente${d.suggested ? ` (las reglas sugerían «${LEARNING_TYPE_LABELS[d.suggested]}»)` : ''}.`;
  }
  if (d.ruleId === 'lt.default') return 'Sin pistas claras en el objetivo ni en el título: se usa «Conceptual» por defecto (puedes fijarlo).';
  const fieldLabel: Record<string, string> = { objective: 'objetivo', title: 'título', description: 'descripción' };
  const ev = d.evidence.map((e) => `«${e.cue.replace(/\*$/, '…')}» (${fieldLabel[e.field]})`).join(', ');
  return `${d.ruleId.endsWith('.term') ? 'Términos' : 'Verbos'} del capítulo: ${ev}.`;
}
