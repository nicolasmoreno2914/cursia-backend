/**
 * r107 B8 · Taller de cursos — diagnóstico de CALIDAD (Q01–Q05, diseño §5 «Calidad») y preguntas puntuales: tipos.
 *
 * Un hallazgo de calidad tiene EXACTAMENTE la forma de un hallazgo técnico de B3 (título para docentes, severidad,
 * alcance, evidencia legible + detalle técnico, `suggestedFix` + `fixPrecheck`), para que «Arreglar esto» de B5 lo trate
 * igual; cambia el check (`Q01`…`Q05`), y se agregan su ORIGEN (`origin: 'quality'`), de dónde salió (`source`: regla
 * determinista gratis o revisión de IA aprobada) y las CITAS literales que lo sostienen (actividad + fragmento).
 *
 * Puro.
 */
import type { Finding } from '../diagnosis/finding';

export type QualityCheckId = 'Q01' | 'Q02' | 'Q03' | 'Q04' | 'Q05';
export const QUALITY_CHECK_IDS: readonly QualityCheckId[] = Object.freeze(['Q01', 'Q02', 'Q03', 'Q04', 'Q05']) as readonly QualityCheckId[];

export const QUALITY_CHECK_TITLES: Readonly<Record<QualityCheckId, string>> = Object.freeze({
  Q01: 'Idioma (español latinoamericano) y ortografía',
  Q02: 'Coherencia entre Libro Guía, video y examen del mismo capítulo',
  Q03: 'Preguntas adivinables o con sesgo',
  Q04: 'Datos que se contradicen entre capítulos',
  Q05: 'Cobertura: cada capítulo tiene una evaluación que lo cubre',
});

/** Versión del ARMADO del diagnóstico de calidad (subirla en cada cambio de una regla o de un prompt). */
export const QUALITY_CODE_VERSION = 'b8-r2';
export const QUALITY_SCHEMA = 1;

/** Una cita que sostiene un hallazgo: la actividad y el fragmento LITERAL (tal como está en la evidencia). */
export interface QualityQuote {
  /** Id del bloque de evidencia (E…) de la revisión, o null en las reglas deterministas. */
  docId: string | null;
  moduleId: number;
  questionId: number | null;
  chapterNumber: number | null;
  /** Qué es, en español («Libro Guía», «video», «examen»…). */
  what: string;
  activityTitle: string;
  text: string;
}

export type QualityFinding = Omit<Finding, 'check'> & {
  check: QualityCheckId;
  origin: 'quality';
  source: 'deterministic' | 'ai';
  quotes: QualityQuote[];
  /** Solo hallazgos de IA (b8-r2): el título viene prefijado «La IA señala: …» y la sugerencia NO está verificada. */
  aiText?: true;
  aiSuggestion?: string | null;
};

/** Rol de un texto del curso para la calidad (qué es, para el docente y para elegir el arreglo). */
export type QualityDocRole = 'text' | 'libro' | 'video' | 'game' | 'exam' | 'other';

/** Un texto del curso (por actividad, capítulo del Libro o pregunta de examen), ya en texto plano. */
export interface QualityDoc {
  /** Id estable dentro del curso: `a<moduleId>[.<campo>]`, `q<questionId>`, `l<moduleId>.c<capítulo>`. */
  key: string;
  moduleId: number;
  questionId: number | null;
  /** Campo HTML del que sale (para edit_html), si es uno. */
  field: string | null;
  chapterNumber: number | null;
  moduleNumber: number | null;
  role: QualityDocRole;
  what: string;
  activityTitle: string;
  text: string;
}

export const QUALITY_LIMITS = Object.freeze({
  /** Texto de un bloque de evidencia de la revisión de IA. */
  docMaxChars: 6_000,
  /** Evidencia total de UN capítulo (lo que va al modelo por llamada). */
  packetMaxChars: 28_000,
  /** Preguntas de examen por capítulo en la revisión. */
  questionsPerChapter: 15,
  /** Hallazgos que la IA puede devolver por capítulo. */
  aiFindingsMax: 12,
  quoteMin: 8,
  quoteMax: 300,
  titleMax: 200,
  suggestionMax: 600,
  /** Preguntas puntuales. */
  questionMaxChars: 1_000,
  askPassagesMax: 24,
  askEvidenceMaxChars: 14_000,
  askPassageChars: 700,
  askAnswerMax: 1_500,
  askCitationsMax: 8,
  questionsPerSession: 200,
});

export const QUALITY_ERRORS = Object.freeze({
  DIAGNOSIS_NOT_READY: 'WORKSHOP_DIAGNOSIS_NOT_READY',
  NOT_READY: 'WORKSHOP_QUALITY_NOT_READY',
  BUSY: 'WORKSHOP_QUALITY_BUSY',
  CHAPTERS_INVALID: 'WORKSHOP_QUALITY_CHAPTERS_INVALID',
  NOTHING_TO_REVIEW: 'WORKSHOP_QUALITY_NOTHING_TO_REVIEW',
  PREPARE_FAILED: 'WORKSHOP_QUALITY_FAILED',
  INTERRUPTED: 'WORKSHOP_QUALITY_INTERRUPTED',
  QUESTION_EMPTY: 'WORKSHOP_QUESTION_EMPTY',
  QUESTION_TOO_LONG: 'WORKSHOP_QUESTION_TOO_LONG',
  QUESTION_NOT_FOUND: 'WORKSHOP_QUESTION_NOT_FOUND',
  QUESTION_NOT_AWAITING: 'WORKSHOP_QUESTION_NOT_AWAITING_CONFIRMATION',
  QUESTION_FAILED: 'WORKSHOP_QUESTION_FAILED',
  QUESTIONS_LIMIT: 'WORKSHOP_QUESTIONS_LIMIT',
  REQUEST_INVALID: 'WORKSHOP_QUALITY_REQUEST_INVALID',
});

/** Mensaje EXACTO cuando la respuesta no tiene evidencia válida (nunca se inventa). */
export const NO_EVIDENCE_MESSAGE = 'No encontré evidencia suficiente en el curso para responder';
