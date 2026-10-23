import {
  ASSESSMENT_METHODS,
  AssessmentMethod,
  ENUM_TARGETS,
  EXPERIENCE_TYPES,
  EnumTarget,
  ExperienceLevel,
  ExperienceType,
  LEARNING_MODES,
  LIST_TARGETS,
  LearningMode,
  ListTarget,
  PEDAGOGICAL_DIMENSIONS,
  PedagogicalDimensions,
  PriorKnowledgeLevel,
  SECTION_KINDS,
  SectionKind,
  AgeGroup,
  ChapterRole,
} from './vocabulary';

/**
 * Motor pedagógico V1 — definición de un enfoque y registro.
 *
 * Un enfoque es SOLO datos:
 *  - `dimensions`: su perfil en las 11 dimensiones (0..1);
 *  - `votes`: para cada meta de elección única, el valor que propone (con peso);
 *  - `lists`: para cada meta de lista, sus elementos en orden de preferencia;
 *  - `sequence`: la secuencia base de un capítulo cuando es el enfoque PRINCIPAL;
 *  - `signatureSteps`: los pasos que aporta cuando es SECUNDARIO;
 *  - `roleOverrides`: votos que solo valen para el primer/último capítulo del módulo;
 *  - `objectiveVerbs`: verbos observables preferidos para los objetivos;
 *  - `affinity`: cuánto encaja con cada respuesta de «No estoy seguro».
 * El motor (design-rules.ts / recommendation.ts) recorre el registro; nunca
 * pregunta por un id concreto.
 */

export interface ApproachVote {
  value: string;
  /** 0..1: cuánto le importa esta meta al enfoque (decide el empate entre enfoques combinados). */
  weight: number;
  /** id estable de la regla (aparece en la traza «reglas aplicadas»). */
  ruleId: string;
  /** Por qué (se muestra en el dry-run). */
  rationale: string;
}

export interface SignatureStep {
  step: SectionKind;
  at: 'start' | 'end';
}

export interface ApproachAffinity {
  learningModes: Partial<Record<LearningMode, number>>;
  experienceTypes: Partial<Record<ExperienceType, number>>;
  assessmentMethods: Partial<Record<AssessmentMethod, number>>;
  priorKnowledge: Partial<Record<PriorKnowledgeLevel, number>>;
  experience: Partial<Record<ExperienceLevel, number>>;
  ageGroups: Partial<Record<AgeGroup, number>>;
  /** Afinidad con el balance de resultados de aprendizaje (P2). */
  outcomes: { know: number; do: number; competencies: number };
}

export interface PedagogicalApproachDefinition {
  id: string;
  label: string;
  shortLabel: string;
  summary: string;
  dimensions: PedagogicalDimensions;
  votes: Partial<Record<EnumTarget, ApproachVote>>;
  lists: Partial<Record<ListTarget, { items: string[]; weight: number; ruleId: string; rationale: string }>>;
  sequence: SectionKind[];
  signatureSteps: SignatureStep[];
  roleOverrides?: Partial<Record<ChapterRole, Partial<Record<EnumTarget, ApproachVote>>>>;
  objectiveVerbs: string[];
  affinity: ApproachAffinity;
}

export interface ApproachDefinitionError {
  path: string;
  message: string;
}

const ID_RE = /^[a-z][a-z0-9_]{2,40}$/;

/** Valida un enfoque contra el vocabulario cerrado (un enfoque mal escrito nunca entra al registro). */
export function validateApproachDefinition(a: PedagogicalApproachDefinition): ApproachDefinitionError[] {
  const errors: ApproachDefinitionError[] = [];
  const err = (path: string, message: string) => errors.push({ path: `${a?.id ?? '?'}.${path}`, message });
  if (!a || typeof a !== 'object') return [{ path: '?', message: 'el enfoque debe ser un objeto' }];
  if (!ID_RE.test(String(a.id))) err('id', 'id inválido (minúsculas, dígitos y _, 3–41 caracteres)');
  for (const k of ['label', 'shortLabel', 'summary'] as const) {
    if (typeof a[k] !== 'string' || !a[k].trim()) err(k, 'texto obligatorio');
  }
  for (const d of PEDAGOGICAL_DIMENSIONS) {
    const v = a.dimensions?.[d];
    if (typeof v !== 'number' || !(v >= 0 && v <= 1)) err(`dimensions.${d}`, 'debe ser un número entre 0 y 1');
  }
  for (const k of Object.keys(a.dimensions ?? {})) {
    if (!(PEDAGOGICAL_DIMENSIONS as readonly string[]).includes(k)) err(`dimensions.${k}`, 'dimensión desconocida');
  }
  const checkVote = (path: string, target: string, v: ApproachVote | undefined) => {
    if (!v) return;
    const allowed = (ENUM_TARGETS as Record<string, readonly string[]>)[target];
    if (!allowed) return err(path, `meta desconocida: ${target}`);
    if (!allowed.includes(v.value)) err(path, `valor ${JSON.stringify(v.value)} no permitido (permitidos: ${allowed.join(', ')})`);
    if (typeof v.weight !== 'number' || !(v.weight > 0 && v.weight <= 1)) err(path, 'weight debe estar en (0, 1]');
    if (typeof v.ruleId !== 'string' || !v.ruleId) err(path, 'ruleId obligatorio');
    if (typeof v.rationale !== 'string' || !v.rationale) err(path, 'rationale obligatorio');
  };
  for (const [t, v] of Object.entries(a.votes ?? {})) checkVote(`votes.${t}`, t, v);
  for (const [role, votes] of Object.entries(a.roleOverrides ?? {})) {
    if (!['module_opening', 'core', 'module_closing', 'single'].includes(role)) err(`roleOverrides.${role}`, 'rol desconocido');
    for (const [t, v] of Object.entries(votes ?? {})) checkVote(`roleOverrides.${role}.${t}`, t, v);
  }
  for (const [t, l] of Object.entries(a.lists ?? {})) {
    const allowed = (LIST_TARGETS as Record<string, readonly string[]>)[t];
    if (!allowed) {
      err(`lists.${t}`, `meta de lista desconocida: ${t}`);
      continue;
    }
    if (!Array.isArray(l?.items) || l.items.length === 0) err(`lists.${t}`, 'items debe ser un array no vacío');
    else {
      l.items.forEach((x, i) => { if (!allowed.includes(x)) err(`lists.${t}[${i}]`, `valor ${JSON.stringify(x)} no permitido`); });
      if (new Set(l.items).size !== l.items.length) err(`lists.${t}`, 'items repetidos');
    }
    if (typeof l?.weight !== 'number' || !(l.weight > 0 && l.weight <= 1)) err(`lists.${t}.weight`, 'weight debe estar en (0, 1]');
    if (typeof l?.ruleId !== 'string' || !l.ruleId) err(`lists.${t}.ruleId`, 'ruleId obligatorio');
  }
  if (!Array.isArray(a.sequence) || a.sequence.length < 3) err('sequence', 'la secuencia necesita al menos 3 pasos');
  else {
    a.sequence.forEach((s, i) => { if (!(SECTION_KINDS as readonly string[]).includes(s)) err(`sequence[${i}]`, `paso desconocido: ${s}`); });
    if (new Set(a.sequence).size !== a.sequence.length) err('sequence', 'pasos repetidos');
  }
  (a.signatureSteps ?? []).forEach((s, i) => {
    if (!(SECTION_KINDS as readonly string[]).includes(s?.step)) err(`signatureSteps[${i}]`, `paso desconocido: ${s?.step}`);
    if (s?.at !== 'start' && s?.at !== 'end') err(`signatureSteps[${i}].at`, "debe ser 'start' o 'end'");
  });
  if (!Array.isArray(a.objectiveVerbs) || a.objectiveVerbs.length === 0) err('objectiveVerbs', 'al menos un verbo');
  const checkAff = (path: string, map: Record<string, number> | undefined, allowed: readonly string[]) => {
    for (const [k, v] of Object.entries(map ?? {})) {
      if (!allowed.includes(k)) err(`affinity.${path}.${k}`, 'opción desconocida');
      if (typeof v !== 'number' || !(v >= 0 && v <= 1)) err(`affinity.${path}.${k}`, 'debe estar entre 0 y 1');
    }
  };
  checkAff('learningModes', a.affinity?.learningModes, LEARNING_MODES);
  checkAff('experienceTypes', a.affinity?.experienceTypes, EXPERIENCE_TYPES);
  checkAff('assessmentMethods', a.affinity?.assessmentMethods, ASSESSMENT_METHODS);
  const o = a.affinity?.outcomes;
  if (!o || [o.know, o.do, o.competencies].some((v) => typeof v !== 'number' || !(v >= 0 && v <= 1))) {
    err('affinity.outcomes', 'know/do/competencies entre 0 y 1');
  }
  return errors;
}

/**
 * Registro de enfoques. El motor recibe un registro (default: el de los 5
 * enfoques iniciales) — así un enfoque nuevo se prueba o se agrega sin
 * modificar el motor.
 */
export class PedagogicalApproachRegistry {
  private readonly byId = new Map<string, PedagogicalApproachDefinition>();

  constructor(approaches: readonly PedagogicalApproachDefinition[] = []) {
    for (const a of approaches) this.register(a);
  }

  register(a: PedagogicalApproachDefinition): this {
    const errors = validateApproachDefinition(a);
    if (errors.length > 0) {
      throw new Error(`APPROACH_INVALID: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    }
    if (this.byId.has(a.id)) throw new Error(`APPROACH_DUPLICATE: ${a.id}`);
    this.byId.set(a.id, deepFreeze(structuredCloneJson(a)));
    return this;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): PedagogicalApproachDefinition {
    const a = this.byId.get(id);
    if (!a) throw new Error(`APPROACH_UNKNOWN: ${id}`);
    return a;
  }

  /** En orden de registro (estable). */
  list(): PedagogicalApproachDefinition[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  /** Copia con un enfoque más (el registro original no cambia). */
  with(a: PedagogicalApproachDefinition): PedagogicalApproachRegistry {
    return new PedagogicalApproachRegistry([...this.list(), a]);
  }
}

function structuredCloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
