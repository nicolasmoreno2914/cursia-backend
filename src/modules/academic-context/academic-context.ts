import { sha256Canonical } from '../coherence/canonical-json';
import { EDUCATION_LEVELS, EducationLevel, isOneOf } from '../pedagogy/vocabulary';

/**
 * Fase 3 — Contexto académico del curso (el «Context Package» del roadmap). Spec:
 * docs/superpowers/specs/2026-10-05-academic-context-design.md.
 *
 * Contexto académico ESTRUCTURADO e independiente del documento original: cada dato dice si se ENCONTRÓ en un
 * documento (con su fuente y un extracto), si se INFIRIÓ con una regla declarada (`basis`), si FALTA, o si lo
 * escribió el docente. Se guarda como perfil versionado (`course_profiles.kind = 'academic'`).
 *
 * No confundir con el «Context Package» por corrida de la Fase 6/R2 (46-dynamic-context-package.js), que arma el
 * contexto de generación de cada item: este es el contexto ACADÉMICO del curso (programa, resultados, contenidos…).
 *
 * Puro: sin DB, sin red, sin reloj. Validación estricta (claves exactas, ids con formato, límites); nunca se
 * «arregla» un valor inválido en silencio.
 */

export const ACADEMIC_CONTEXT_VERSION = 1 as const;

export const ACADEMIC_LIMITS = Object.freeze({
  documents: 5,
  outcomes: 40,
  competencies: 30,
  units: 20,
  contentsPerUnit: 40,
  components: 12,
  evaluation: 20,
  bibliography: 80,
  listItems: 20,
  conflicts: 20,
  outcomeIdsPerItem: 8,
  sourcesPerItem: 4,
  text: 600,
  outcomeText: 400,
  title: 200,
  excerpt: 240,
  basis: 200,
  name: 200,
  jsonBytes: 256 * 1024,
});

export type FieldStatus = 'found' | 'inferred' | 'missing' | 'provided';
export const FIELD_STATUSES: readonly FieldStatus[] = ['found', 'inferred', 'missing', 'provided'];

export type BloomLevel = 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create';
export const BLOOM_LEVELS: readonly BloomLevel[] = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'];
export type OutcomeDomain = 'know' | 'do';
export type HoursComponentKind = 'contact' | 'practice' | 'autonomous' | 'other';
export const HOURS_COMPONENT_KINDS: readonly HoursComponentKind[] = ['contact', 'practice', 'autonomous', 'other'];

export interface SourceRef {
  documentId: string;
  section: string | null;
  page: number | null;
  line: number | null;
  excerpt: string;
}

export interface Field<T> {
  status: FieldStatus;
  value: T | null;
  sources: SourceRef[];
  /** Obligatorio con status `inferred`: la regla que produjo el valor. */
  basis?: string;
  /** Lectura con dudas (🟡): qué debe confirmar o completar el docente. Nunca bloquea; solo se muestra. */
  review?: string;
  /** Solo `hours.total`: el documento da un RANGO («40–44 horas»); `value` es el punto medio (meta de diseño). */
  range?: { min: number; max: number };
}

/** Elemento de una lista (resultado, contenido, referencia…): mismo contrato de estado y fuente que un Field. */
export interface Provenance {
  status: Exclude<FieldStatus, 'missing'>;
  sources: SourceRef[];
  basis?: string;
  /** Lectura con dudas (🟡): qué debe confirmar o completar el docente (texto cortado, tabla reconstruida…). */
  review?: string;
}

export interface AcademicDocument {
  id: string;
  name: string;
  mediaType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'text/plain' | 'text/markdown';
  sha256: string;
  bytes: number;
  pages: number | null;
  characters: number;
  extractor: { id: string; version: number };
}

export interface LearningOutcome extends Provenance {
  id: string;
  text: string;
  level: BloomLevel | null;
  domain: OutcomeDomain;
}

export interface Competency extends Provenance {
  id: string;
  text: string;
}

export interface UnitContent extends Provenance {
  id: string;
  text: string;
  outcomeIds: string[];
}

export interface ThematicUnit extends Provenance {
  id: string;
  title: string;
  hours: number | null;
  outcomeIds: string[];
  contents: UnitContent[];
}

export interface HoursComponent extends Provenance {
  id: string;
  label: string;
  kind: HoursComponentKind;
  hours: number;
}

export interface EvaluationItem extends Provenance {
  id: string;
  instrument: string;
  weightPct: number | null;
  outcomeIds: string[];
}

export interface BibliographyItem extends Provenance {
  id: string;
  text: string;
}

export interface AcademicContextV1 {
  academicContextVersion: 1;
  documents: AcademicDocument[];
  identity: {
    subjectName: Field<string>;
    program: Field<string>;
    educationLevel: Field<{ text: string; level: EducationLevel | null }>;
    generalObjective: Field<string>;
    description: Field<string>;
  };
  learner: {
    profile: Field<string>;
    priorKnowledge: Field<string[]>;
  };
  outcomes: LearningOutcome[];
  competencies: Competency[];
  units: ThematicUnit[];
  hours: {
    total: Field<number>;
    weekly: Field<number>;
    weeks: Field<number>;
    credits: Field<number>;
    components: HoursComponent[];
  };
  evaluation: EvaluationItem[];
  bibliography: BibliographyItem[];
  methodology: Field<string>;
  constraints: Field<string[]>;
  additionalInfo: Field<string[]>;
  /** Un mismo dato con valores distintos en el documento (o entre documentos): se conserva el primero y se avisa. */
  conflicts: ContextConflict[];
}

export interface ContextConflict {
  /** Ruta del dato (p. ej. `hours.total`). */
  path: string;
  values: { value: string; source: SourceRef }[];
}

export interface AcademicSchemaError {
  path: string;
  code: string;
  message: string;
}

export const ID_PATTERNS = Object.freeze({
  document: /^D[1-9]$/,
  outcome: /^RA[0-9]{1,3}$/,
  competency: /^CO[0-9]{1,3}$/,
  unit: /^U[0-9]{1,2}$/,
  content: /^U[0-9]{1,2}\.[0-9]{1,3}$/,
  component: /^H[0-9]{1,2}$/,
  evaluation: /^EV[0-9]{1,2}$/,
  bibliography: /^B[0-9]{1,3}$/,
});
/** Un vínculo a resultado de aprendizaje o competencia (lo que referencian contenidos, evaluaciones y capítulos). */
export const OUTCOME_REF_RE = /^(RA|CO)[0-9]{1,3}$/;

export const MEDIA_TYPES: readonly AcademicDocument['mediaType'][] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
];

export function missingField<T>(): Field<T> {
  return { status: 'missing', value: null, sources: [] };
}

/** Contexto vacío (sin documentos): todo `missing`. */
export function emptyAcademicContext(): AcademicContextV1 {
  return {
    academicContextVersion: ACADEMIC_CONTEXT_VERSION,
    documents: [],
    identity: { subjectName: missingField(), program: missingField(), educationLevel: missingField(), generalObjective: missingField(), description: missingField() },
    learner: { profile: missingField(), priorKnowledge: missingField() },
    outcomes: [],
    competencies: [],
    units: [],
    hours: { total: missingField(), weekly: missingField(), weeks: missingField(), credits: missingField(), components: [] },
    evaluation: [],
    bibliography: [],
    methodology: missingField(),
    constraints: missingField(),
    additionalInfo: missingField(),
    conflicts: [],
  };
}

// ── Validación de forma ────────────────────────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

class Checker {
  readonly errors: AcademicSchemaError[] = [];
  err(path: string, code: string, message: string): void {
    this.errors.push({ path, code, message });
  }
  keys(v: Record<string, unknown>, path: string, required: readonly string[], optional: readonly string[] = []): void {
    for (const k of required) if (!(k in v)) this.err(path ? `${path}.${k}` : k, 'MISSING_FIELD', `Falta el campo "${path ? `${path}.` : ''}${k}"`);
    for (const k of Object.keys(v)) {
      if (!required.includes(k) && !optional.includes(k)) this.err(path ? `${path}.${k}` : k, 'UNKNOWN_FIELD', `Campo desconocido "${path ? `${path}.` : ''}${k}"`);
    }
  }
  text(v: unknown, path: string, max: number, allowEmpty = false): v is string {
    if (typeof v !== 'string') {
      this.err(path, 'INVALID_TEXT', `${path} debe ser texto`);
      return false;
    }
    if (!allowEmpty && !v.trim()) {
      this.err(path, 'EMPTY_TEXT', `${path} no puede estar vacío`);
      return false;
    }
    if (v.length > max) {
      this.err(path, 'TEXT_TOO_LONG', `${path} supera ${max} caracteres`);
      return false;
    }
    return true;
  }
  list(v: unknown, path: string, max: number): v is unknown[] {
    if (!Array.isArray(v)) {
      this.err(path, 'INVALID_TYPE', `${path} debe ser una lista`);
      return false;
    }
    if (v.length > max) this.err(path, 'TOO_MANY_ITEMS', `${path}: como máximo ${max} elementos`);
    return true;
  }
  intOrNull(v: unknown, path: string, min: number, max: number): void {
    if (v === null) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) this.err(path, 'INVALID_NUMBER', `${path} debe ser un entero de ${min} a ${max} o null`);
  }
  hours(v: unknown, path: string, max = 5000): void {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max || Math.round(v * 100) !== v * 100) {
      this.err(path, 'INVALID_HOURS', `${path} debe ser un número de 0 a ${max} (máximo dos decimales)`);
    }
  }
  sources(v: unknown, path: string, docIds: Set<string>): void {
    if (!this.list(v, path, ACADEMIC_LIMITS.sourcesPerItem)) return;
    (v as unknown[]).forEach((s, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(s)) return this.err(p, 'INVALID_TYPE', `${p} debe ser un objeto`);
      this.keys(s, p, ['documentId', 'section', 'page', 'line', 'excerpt']);
      if (typeof s.documentId !== 'string' || !docIds.has(s.documentId)) this.err(`${p}.documentId`, 'UNKNOWN_DOCUMENT', `${p}.documentId no corresponde a ningún documento`);
      if (s.section !== null) this.text(s.section, `${p}.section`, 80);
      this.intOrNull(s.page, `${p}.page`, 1, 10000);
      this.intOrNull(s.line, `${p}.line`, 1, 1000000);
      this.text(s.excerpt, `${p}.excerpt`, ACADEMIC_LIMITS.excerpt);
    });
  }
  /** status/sources/basis de un elemento de lista o de un Field. */
  provenance(v: Record<string, unknown>, path: string, docIds: Set<string>, allowMissing: boolean): void {
    const allowed = allowMissing ? FIELD_STATUSES : FIELD_STATUSES.filter((s) => s !== 'missing');
    if (!allowed.includes(v.status as FieldStatus)) {
      this.err(`${path}.status`, 'INVALID_STATUS', `${path}.status inválido (permitidos: ${allowed.join(', ')})`);
      return;
    }
    this.sources(v.sources, `${path}.sources`, docIds);
    const n = Array.isArray(v.sources) ? v.sources.length : 0;
    if (v.status === 'found' && n === 0) this.err(`${path}.sources`, 'FOUND_WITHOUT_SOURCE', `${path}: un dato encontrado necesita su fuente`);
    if ((v.status === 'missing' || v.status === 'provided') && n > 0) this.err(`${path}.sources`, 'UNEXPECTED_SOURCE', `${path}: un dato ${v.status} no lleva fuentes`);
    if (v.review !== undefined) this.text(v.review, `${path}.review`, ACADEMIC_LIMITS.basis);
    if (v.status === 'inferred') {
      if (v.basis === undefined) this.err(`${path}.basis`, 'INFERRED_WITHOUT_BASIS', `${path}: un dato inferido necesita la regla que lo produjo (basis)`);
      else this.text(v.basis, `${path}.basis`, ACADEMIC_LIMITS.basis);
    } else if (v.basis !== undefined) {
      this.err(`${path}.basis`, 'UNEXPECTED_BASIS', `${path}: basis solo va en datos inferidos`);
    }
  }
  field(v: unknown, path: string, docIds: Set<string>, value: (x: unknown, p: string) => void): void {
    if (!isObj(v)) return this.err(path, 'INVALID_TYPE', `${path} debe ser un objeto {status, value, sources}`);
    this.keys(v, path, ['status', 'value', 'sources'], path === 'hours.total' ? ['basis', 'review', 'range'] : ['basis', 'review']);
    this.provenance(v, path, docIds, true);
    if (v.range !== undefined) {
      const r = v.range as Record<string, unknown> | null;
      if (!isObj(r) || typeof r.min !== 'number' || typeof r.max !== 'number' || !(r.min > 0) || !(r.max >= r.min) || r.max > 5000) {
        this.err(`${path}.range`, 'INVALID_RANGE', `${path}.range debe ser {min, max} con 0 < min ≤ max`);
      } else if (v.status === 'missing') this.err(`${path}.range`, 'MISSING_WITH_VALUE', `${path}: un dato faltante no lleva rango`);
      else if (typeof v.value === 'number' && (v.value < r.min || v.value > r.max)) this.err(`${path}.range`, 'VALUE_OUTSIDE_RANGE', `${path}: el valor debe estar dentro del rango`);
    }
    if (v.status === 'missing') {
      if (v.value !== null) this.err(`${path}.value`, 'MISSING_WITH_VALUE', `${path}: un dato faltante no lleva valor`);
    } else if (v.value === null) {
      this.err(`${path}.value`, 'VALUE_REQUIRED', `${path}: un dato ${String(v.status)} necesita valor`);
    } else {
      value(v.value, `${path}.value`);
    }
  }
  outcomeRefs(v: unknown, path: string): void {
    if (!this.list(v, path, ACADEMIC_LIMITS.outcomeIdsPerItem)) return;
    const arr = v as unknown[];
    arr.forEach((x, i) => {
      if (typeof x !== 'string' || !OUTCOME_REF_RE.test(x)) this.err(`${path}[${i}]`, 'INVALID_OUTCOME_REF', `${path}[${i}] debe ser un id RA… o CO…`);
    });
    if (new Set(arr).size !== arr.length) this.err(path, 'DUPLICATE_OUTCOME_REF', `${path} repite ids`);
  }
}

/**
 * Valida la FORMA completa del contexto (claves exactas, tipos, ids, límites, fuentes que apuntan a documentos
 * existentes). La coherencia semántica (horas que no suman, resultados sin contenido…) es validateAcademicContext.
 */
export function validateAcademicContextShape(input: unknown): AcademicSchemaError[] {
  const c = new Checker();
  if (!isObj(input)) return [{ path: '', code: 'INVALID_TYPE', message: 'El contexto académico debe ser un objeto' }];
  try {
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > ACADEMIC_LIMITS.jsonBytes) {
      return [{ path: '', code: 'CONTEXT_TOO_LARGE', message: `El contexto académico supera ${ACADEMIC_LIMITS.jsonBytes / 1024} KB` }];
    }
  } catch {
    return [{ path: '', code: 'INVALID_TYPE', message: 'El contexto académico no es serializable' }];
  }
  const v = input;
  c.keys(v, '', ['academicContextVersion', 'documents', 'identity', 'learner', 'outcomes', 'competencies', 'units', 'hours', 'evaluation', 'bibliography', 'methodology', 'constraints', 'additionalInfo', 'conflicts']);
  if ('academicContextVersion' in v && v.academicContextVersion !== ACADEMIC_CONTEXT_VERSION) {
    c.err('academicContextVersion', 'INVALID_VERSION', `academicContextVersion debe ser ${ACADEMIC_CONTEXT_VERSION}`);
  }

  const docIds = new Set<string>();
  if (c.list(v.documents, 'documents', ACADEMIC_LIMITS.documents)) {
    (v.documents as unknown[]).forEach((d, i) => {
      const p = `documents[${i}]`;
      if (!isObj(d)) return c.err(p, 'INVALID_TYPE', `${p} debe ser un objeto`);
      c.keys(d, p, ['id', 'name', 'mediaType', 'sha256', 'bytes', 'pages', 'characters', 'extractor']);
      if (typeof d.id !== 'string' || !ID_PATTERNS.document.test(d.id)) c.err(`${p}.id`, 'INVALID_ID', `${p}.id debe ser D1…D9`);
      else if (docIds.has(d.id)) c.err(`${p}.id`, 'DUPLICATE_ID', `${p}.id repetido`);
      else docIds.add(d.id);
      c.text(d.name, `${p}.name`, ACADEMIC_LIMITS.name);
      if (!MEDIA_TYPES.includes(d.mediaType as AcademicDocument['mediaType'])) c.err(`${p}.mediaType`, 'INVALID_MEDIA_TYPE', `${p}.mediaType no soportado`);
      if (typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) c.err(`${p}.sha256`, 'INVALID_SHA', `${p}.sha256 debe ser hex de 64`);
      c.intOrNull(d.bytes, `${p}.bytes`, 1, 50 * 1024 * 1024);
      if (d.bytes === null) c.err(`${p}.bytes`, 'INVALID_NUMBER', `${p}.bytes es obligatorio`);
      c.intOrNull(d.pages, `${p}.pages`, 1, 10000);
      c.intOrNull(d.characters, `${p}.characters`, 0, 50 * 1024 * 1024);
      if (d.characters === null) c.err(`${p}.characters`, 'INVALID_NUMBER', `${p}.characters es obligatorio`);
      if (!isObj(d.extractor)) c.err(`${p}.extractor`, 'INVALID_TYPE', `${p}.extractor debe ser un objeto`);
      else {
        c.keys(d.extractor, `${p}.extractor`, ['id', 'version']);
        c.text(d.extractor.id, `${p}.extractor.id`, 80);
        c.intOrNull(d.extractor.version, `${p}.extractor.version`, 1, 1000);
      }
    });
  }

  const textValue = (max: number) => (x: unknown, p: string) => { c.text(x, p, max); };
  const listValue = (x: unknown, p: string) => {
    if (c.list(x, p, ACADEMIC_LIMITS.listItems)) (x as unknown[]).forEach((y, i) => c.text(y, `${p}[${i}]`, ACADEMIC_LIMITS.text));
  };
  const hoursValue = (x: unknown, p: string) => c.hours(x, p);

  if (!isObj(v.identity)) c.err('identity', 'INVALID_TYPE', 'identity debe ser un objeto');
  else {
    c.keys(v.identity, 'identity', ['subjectName', 'program', 'educationLevel', 'generalObjective', 'description']);
    c.field(v.identity.subjectName, 'identity.subjectName', docIds, textValue(ACADEMIC_LIMITS.title));
    c.field(v.identity.program, 'identity.program', docIds, textValue(ACADEMIC_LIMITS.title));
    c.field(v.identity.educationLevel, 'identity.educationLevel', docIds, (x, p) => {
      if (!isObj(x)) return c.err(p, 'INVALID_TYPE', `${p} debe ser {text, level}`);
      c.keys(x, p, ['text', 'level']);
      c.text(x.text, `${p}.text`, ACADEMIC_LIMITS.title);
      if (x.level !== null && !isOneOf(EDUCATION_LEVELS, x.level)) c.err(`${p}.level`, 'INVALID_OPTION', `${p}.level inválido (permitidos: ${EDUCATION_LEVELS.join(', ')} o null)`);
    });
    c.field(v.identity.generalObjective, 'identity.generalObjective', docIds, textValue(ACADEMIC_LIMITS.text));
    c.field(v.identity.description, 'identity.description', docIds, textValue(ACADEMIC_LIMITS.text));
  }
  if (!isObj(v.learner)) c.err('learner', 'INVALID_TYPE', 'learner debe ser un objeto');
  else {
    c.keys(v.learner, 'learner', ['profile', 'priorKnowledge']);
    c.field(v.learner.profile, 'learner.profile', docIds, textValue(ACADEMIC_LIMITS.text));
    c.field(v.learner.priorKnowledge, 'learner.priorKnowledge', docIds, listValue);
  }

  const seen = new Set<string>();
  const uniqueId = (id: unknown, path: string, re: RegExp, label: string) => {
    if (typeof id !== 'string' || !re.test(id)) return c.err(path, 'INVALID_ID', `${path} debe tener el formato de ${label}`);
    if (seen.has(id)) return c.err(path, 'DUPLICATE_ID', `${path}: id «${id}» repetido`);
    seen.add(id);
  };
  const item = (x: unknown, p: string, required: string[], optional: string[] = []): x is Record<string, unknown> => {
    if (!isObj(x)) {
      c.err(p, 'INVALID_TYPE', `${p} debe ser un objeto`);
      return false;
    }
    c.keys(x, p, [...required, 'status', 'sources'], [...optional, 'basis', 'review']);
    c.provenance(x, p, docIds, false);
    return true;
  };

  if (c.list(v.outcomes, 'outcomes', ACADEMIC_LIMITS.outcomes)) {
    (v.outcomes as unknown[]).forEach((o, i) => {
      const p = `outcomes[${i}]`;
      if (!item(o, p, ['id', 'text', 'level', 'domain'])) return;
      uniqueId(o.id, `${p}.id`, ID_PATTERNS.outcome, 'RA1');
      c.text(o.text, `${p}.text`, ACADEMIC_LIMITS.outcomeText);
      if (o.level !== null && !BLOOM_LEVELS.includes(o.level as BloomLevel)) c.err(`${p}.level`, 'INVALID_OPTION', `${p}.level inválido`);
      if (o.domain !== 'know' && o.domain !== 'do') c.err(`${p}.domain`, 'INVALID_OPTION', `${p}.domain debe ser know o do`);
    });
  }
  if (c.list(v.competencies, 'competencies', ACADEMIC_LIMITS.competencies)) {
    (v.competencies as unknown[]).forEach((o, i) => {
      const p = `competencies[${i}]`;
      if (!item(o, p, ['id', 'text'])) return;
      uniqueId(o.id, `${p}.id`, ID_PATTERNS.competency, 'CO1');
      c.text(o.text, `${p}.text`, ACADEMIC_LIMITS.outcomeText);
    });
  }
  if (c.list(v.units, 'units', ACADEMIC_LIMITS.units)) {
    (v.units as unknown[]).forEach((u, i) => {
      const p = `units[${i}]`;
      if (!item(u, p, ['id', 'title', 'hours', 'outcomeIds', 'contents'])) return;
      uniqueId(u.id, `${p}.id`, ID_PATTERNS.unit, 'U1');
      c.text(u.title, `${p}.title`, ACADEMIC_LIMITS.title);
      if (u.hours !== null) c.hours(u.hours, `${p}.hours`);
      c.outcomeRefs(u.outcomeIds, `${p}.outcomeIds`);
      if (c.list(u.contents, `${p}.contents`, ACADEMIC_LIMITS.contentsPerUnit)) {
        (u.contents as unknown[]).forEach((x, j) => {
          const q = `${p}.contents[${j}]`;
          if (!item(x, q, ['id', 'text', 'outcomeIds'])) return;
          uniqueId(x.id, `${q}.id`, ID_PATTERNS.content, 'U1.1');
          if (typeof x.id === 'string' && typeof u.id === 'string' && !x.id.startsWith(`${u.id}.`)) c.err(`${q}.id`, 'CONTENT_ID_UNIT_MISMATCH', `${q}.id debe empezar con ${u.id}.`);
          c.text(x.text, `${q}.text`, ACADEMIC_LIMITS.text);
          c.outcomeRefs(x.outcomeIds, `${q}.outcomeIds`);
        });
      }
    });
  }
  if (!isObj(v.hours)) c.err('hours', 'INVALID_TYPE', 'hours debe ser un objeto');
  else {
    c.keys(v.hours, 'hours', ['total', 'weekly', 'weeks', 'credits', 'components']);
    c.field(v.hours.total, 'hours.total', docIds, hoursValue);
    c.field(v.hours.weekly, 'hours.weekly', docIds, hoursValue);
    c.field(v.hours.weeks, 'hours.weeks', docIds, (x, p) => c.hours(x, p, 104));
    c.field(v.hours.credits, 'hours.credits', docIds, (x, p) => c.hours(x, p, 60));
    if (c.list(v.hours.components, 'hours.components', ACADEMIC_LIMITS.components)) {
      (v.hours.components as unknown[]).forEach((h, i) => {
        const p = `hours.components[${i}]`;
        if (!item(h, p, ['id', 'label', 'kind', 'hours'])) return;
        uniqueId(h.id, `${p}.id`, ID_PATTERNS.component, 'H1');
        c.text(h.label, `${p}.label`, ACADEMIC_LIMITS.title);
        if (!HOURS_COMPONENT_KINDS.includes(h.kind as HoursComponentKind)) c.err(`${p}.kind`, 'INVALID_OPTION', `${p}.kind inválido`);
        c.hours(h.hours, `${p}.hours`);
      });
    }
  }
  if (c.list(v.evaluation, 'evaluation', ACADEMIC_LIMITS.evaluation)) {
    (v.evaluation as unknown[]).forEach((e, i) => {
      const p = `evaluation[${i}]`;
      if (!item(e, p, ['id', 'instrument', 'weightPct', 'outcomeIds'])) return;
      uniqueId(e.id, `${p}.id`, ID_PATTERNS.evaluation, 'EV1');
      c.text(e.instrument, `${p}.instrument`, ACADEMIC_LIMITS.text);
      if (e.weightPct !== null && (typeof e.weightPct !== 'number' || !Number.isFinite(e.weightPct) || e.weightPct < 0 || e.weightPct > 100)) {
        c.err(`${p}.weightPct`, 'INVALID_NUMBER', `${p}.weightPct debe ser 0–100 o null`);
      }
      c.outcomeRefs(e.outcomeIds, `${p}.outcomeIds`);
    });
  }
  if (c.list(v.bibliography, 'bibliography', ACADEMIC_LIMITS.bibliography)) {
    (v.bibliography as unknown[]).forEach((b, i) => {
      const p = `bibliography[${i}]`;
      if (!item(b, p, ['id', 'text'])) return;
      uniqueId(b.id, `${p}.id`, ID_PATTERNS.bibliography, 'B1');
      c.text(b.text, `${p}.text`, ACADEMIC_LIMITS.text);
    });
  }
  c.field(v.methodology, 'methodology', docIds, textValue(ACADEMIC_LIMITS.text));
  c.field(v.constraints, 'constraints', docIds, listValue);
  c.field(v.additionalInfo, 'additionalInfo', docIds, listValue);
  if (c.list(v.conflicts, 'conflicts', ACADEMIC_LIMITS.conflicts)) {
    (v.conflicts as unknown[]).forEach((k, i) => {
      const p = `conflicts[${i}]`;
      if (!isObj(k)) return c.err(p, 'INVALID_TYPE', `${p} debe ser un objeto`);
      c.keys(k, p, ['path', 'values']);
      c.text(k.path, `${p}.path`, 80);
      if (c.list(k.values, `${p}.values`, ACADEMIC_LIMITS.sourcesPerItem)) {
        if ((k.values as unknown[]).length < 2) c.err(`${p}.values`, 'CONFLICT_NEEDS_TWO', `${p}: un conflicto tiene al menos dos valores`);
        (k.values as unknown[]).forEach((x, j) => {
          const q = `${p}.values[${j}]`;
          if (!isObj(x)) return c.err(q, 'INVALID_TYPE', `${q} debe ser un objeto`);
          c.keys(x, q, ['value', 'source']);
          c.text(x.value, `${q}.value`, ACADEMIC_LIMITS.title);
          c.sources([x.source], `${q}.source`, docIds);
        });
      }
    });
  }
  return c.errors;
}

// ── Normalización canónica (claves en orden fijo, textos colapsados) ──────────────────────────────────────────

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

function normSource(s: SourceRef): SourceRef {
  return { documentId: s.documentId, section: s.section === null ? null : collapse(s.section), page: s.page, line: s.line, excerpt: collapse(s.excerpt) };
}
function normProv<T extends Provenance>(x: T): Provenance {
  return {
    status: x.status, sources: x.sources.map(normSource), ...(x.status === 'inferred' ? { basis: collapse(x.basis as string) } : {}),
    ...(typeof x.review === 'string' ? { review: collapse(x.review) } : {}),
  };
}
function normField<T>(f: Field<T>, value: (v: T) => T): Field<T> {
  return {
    status: f.status,
    value: f.value === null ? null : value(f.value),
    sources: f.sources.map(normSource),
    ...(f.status === 'inferred' ? { basis: collapse(f.basis as string) } : {}),
    ...(typeof f.review === 'string' ? { review: collapse(f.review) } : {}),
    ...(f.range && f.status !== 'missing' ? { range: { min: f.range.min, max: f.range.max } } : {}),
  };
}
const txt = (v: string) => collapse(v);
const txtList = (v: string[]) => v.map(collapse);

/**
 * Forma canónica: valida (lanza ACADEMIC_CONTEXT_INVALID con los códigos) y reconstruye el objeto en orden de
 * claves fijo. El orden de las listas es semántico (el del documento) y se conserva.
 */
export function normalizeAcademicContext(input: unknown): AcademicContextV1 {
  const errors = validateAcademicContextShape(input);
  if (errors.length) {
    throw new Error(`ACADEMIC_CONTEXT_INVALID: ${errors.slice(0, 20).map((e) => `${e.code} ${e.path}: ${e.message}`).join('; ')}`);
  }
  const v = input as AcademicContextV1;
  return {
    academicContextVersion: ACADEMIC_CONTEXT_VERSION,
    documents: v.documents.map((d) => ({
      id: d.id, name: collapse(d.name), mediaType: d.mediaType, sha256: d.sha256, bytes: d.bytes, pages: d.pages,
      characters: d.characters, extractor: { id: d.extractor.id, version: d.extractor.version },
    })),
    identity: {
      subjectName: normField(v.identity.subjectName, txt),
      program: normField(v.identity.program, txt),
      educationLevel: normField(v.identity.educationLevel, (x) => ({ text: collapse(x.text), level: x.level })),
      generalObjective: normField(v.identity.generalObjective, txt),
      description: normField(v.identity.description, txt),
    },
    learner: { profile: normField(v.learner.profile, txt), priorKnowledge: normField(v.learner.priorKnowledge, txtList) },
    outcomes: v.outcomes.map((o) => ({ id: o.id, text: collapse(o.text), level: o.level, domain: o.domain, ...normProv(o) }) as LearningOutcome),
    competencies: v.competencies.map((o) => ({ id: o.id, text: collapse(o.text), ...normProv(o) }) as Competency),
    units: v.units.map((u) => ({
      id: u.id, title: collapse(u.title), hours: u.hours, outcomeIds: [...u.outcomeIds],
      contents: u.contents.map((x) => ({ id: x.id, text: collapse(x.text), outcomeIds: [...x.outcomeIds], ...normProv(x) }) as UnitContent),
      ...normProv(u),
    }) as ThematicUnit),
    hours: {
      total: normField(v.hours.total, (x) => x),
      weekly: normField(v.hours.weekly, (x) => x),
      weeks: normField(v.hours.weeks, (x) => x),
      credits: normField(v.hours.credits, (x) => x),
      components: v.hours.components.map((h) => ({ id: h.id, label: collapse(h.label), kind: h.kind, hours: h.hours, ...normProv(h) }) as HoursComponent),
    },
    evaluation: v.evaluation.map((e) => ({ id: e.id, instrument: collapse(e.instrument), weightPct: e.weightPct, outcomeIds: [...e.outcomeIds], ...normProv(e) }) as EvaluationItem),
    bibliography: v.bibliography.map((b) => ({ id: b.id, text: collapse(b.text), ...normProv(b) }) as BibliographyItem),
    methodology: normField(v.methodology, txt),
    constraints: normField(v.constraints, txtList),
    additionalInfo: normField(v.additionalInfo, txtList),
    conflicts: v.conflicts.map((k) => ({ path: k.path, values: k.values.map((x) => ({ value: collapse(x.value), source: normSource(x.source) })) })),
  };
}

export function academicContextSha256(ctx: AcademicContextV1): string {
  return sha256Canonical(ctx);
}

/** Todos los ids de resultados y competencias definidos (lo que un vínculo puede referenciar). */
export function academicOutcomeIds(ctx: AcademicContextV1): Set<string> {
  return new Set([...ctx.outcomes.map((o) => o.id), ...ctx.competencies.map((o) => o.id)]);
}
