/**
 * LOOP 8.6A · Requisitos explícitos de un documento académico (modelo).
 *
 * Solo INTERPRETACIÓN: documento → líneas → requirements[]. Nada de esto restringe todavía el diseño (8.6C), la
 * verificación (8.6B) ni la generación (8.6E). Sin proveedores, USD 0.
 *
 * Jerarquía que este modelo prepara: requisito del documento → decisión del docente → «Cursia recomienda» → por defecto.
 */

export type RequirementKind =
  | 'modules'
  | 'units' // D5: «unidades» es un tipo propio; no equivale automáticamente a módulos
  | 'chapters'
  | 'target_hours'
  | 'videos'
  | 'application_activities'
  | 'activities' // actividad interactiva del capítulo (no la Actividad de Aplicación)
  | 'evaluations'
  | 'structure'; // forma N × M (con shape)

/** approx = «aproximadamente / alrededor de»: siempre una preferencia, nunca exacto obligatorio. */
export type RequirementMode = 'exact' | 'min' | 'max' | 'range' | 'approx';

/**
 * required: el documento lo exige («deberá», «tendrá», «se realizarán», dato de ficha).
 * recommended: lo sugiere o lo propone («se recomienda», «se propone», «aproximadamente»).
 * permitted: lo permite («podrá», «puede», «hasta … podrán»): un tope o una opción, no una exigencia.
 * informative: describe algo sin aplicar a ESTE curso (catálogo, documento de varias asignaturas sin elegir).
 */
export type RequirementObligation = 'required' | 'recommended' | 'permitted' | 'informative';

/**
 * LOOP 9.2 · chapterKind en el alcance: «capítulos de contenido» / «capítulos de práctica» (por módulo o en el curso), o
 * dónde va algo («1 Actividad de Aplicación por módulo, en el capítulo de práctica»). Sin chapterKind: todos los capítulos.
 */
export type RequirementScope =
  | { level: 'course'; chapterKind?: 'practice' | 'content' }
  | { level: 'module'; each: true; chapterKind?: 'practice' | 'content' }
  | { level: 'module'; index: number }
  | { level: 'chapter'; each: true; chapterKind?: 'practice' | 'content' }
  | { level: 'outcome'; each: true }
  | { level: 'unit'; each: true }
  | { level: 'unit'; index: number }
  | { level: 'structure'; chapterKind?: 'content' }
  | { level: 'subject'; subject: string };

export interface RequirementCondition {
  /** Texto de la condición tal como está en el documento. */
  text: string;
  /** false = depende de algo que Cursia no modela: el requisito queda pendiente de revisión, nunca activo. */
  modeled: boolean;
  field?: 'credits' | 'modality';
  op?: '=' | '>' | '<' | '>=' | '<=';
  value?: number | string;
}

export interface RequirementSource {
  documentId: string;
  /** 1-based (n.º de línea / párrafo / fila del lector). */
  line: number;
  page: number | null;
  /** Cita literal (≤ 300). */
  quote: string;
}

export interface DocumentRequirement {
  id: string;
  /** Identidad semántica estable entre versiones del documento (kind + alcance [+ tipo de evaluación]). */
  key: string;
  kind: RequirementKind;
  scope: RequirementScope;
  mode: RequirementMode;
  /** null solo para 'structure'. */
  value: number | null;
  valueMax?: number;
  /** 'structure': capítulos de cada módulo, p. ej. [5,5,5,5]. */
  shape?: number[];
  /** D2: parciales y final separados cuando el documento los separa. */
  evaluationType?: 'any' | 'partial' | 'final';
  obligation: RequirementObligation;
  /** Grupo compuesto (all) o de alternativas (oneOf). */
  groupId?: string;
  /** Opción dentro de un grupo oneOf. */
  optionId?: string;
  condition?: RequirementCondition;
  /**
   * Activo = aplica a este curso tal como está el documento. Inactivo: condicionado, alternativa no elegida,
   * asignatura no elegida o meramente informativo. Solo los activos podrán restringir el diseño (8.6C).
   */
  active: boolean;
  status: 'found' | 'inferred';
  /** medium = «Revisa esta lectura». */
  confidence: 'high' | 'medium';
  review?: string[];
  source: RequirementSource;
}

export interface RequirementGroup {
  id: string;
  relation: 'all' | 'oneOf';
  label?: string;
  requirementIds?: string[];
  options?: { id: string; label: string; requirementIds: string[] }[];
  source: RequirementSource;
}

export type IgnoredReason =
  | 'example'
  | 'reference' // «capítulo 6 del libro», «página 64», «Parcial 1» (número DESPUÉS del sustantivo: es un ordinal)
  | 'payment'
  | 'component_hours' // horas de clase / acompañamiento / autónomas / semanales: no son el total del estudiante
  | 'no_trigger' // cifra sin verbo de obligación ni campo de ficha: no se convierte en requisito
  | 'condition_clause' // la cifra está dentro de la condición («si el curso tiene más de 5 unidades, …»)
  | 'not_modeled' // el objeto no es algo que Cursia diseñe (foros, webconferencias…)
  | 'not_prescriptive'; // LOOP 9.2: sección que el propio documento declara no prescriptiva («Información no prescriptiva»)

export interface IgnoredNumber {
  reason: IgnoredReason;
  quote: string;
  line: number;
}

export interface RequirementConflict {
  key: string;
  requirementIds: string[];
  message: string;
}

export interface RequirementsExtraction {
  requirementsVersion: 1;
  requirements: DocumentRequirement[];
  groups: RequirementGroup[];
  conflicts: RequirementConflict[];
  ignored: IgnoredNumber[];
  /** El documento describe varias asignaturas (alcance, compendio, catálogo). */
  multiCourse: boolean;
  subjects: string[];
}

/** Lo que se elige para resolver alternativas, asignatura y condiciones. */
export interface RequirementSelection {
  subject?: string;
  /** groupId → optionId (o '*' → etiqueta de opción para todos los grupos). */
  options?: Record<string, string>;
  facts?: { credits?: number; modality?: string };
}
