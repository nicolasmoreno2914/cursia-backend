/**
 * r107 B10 · Taller de cursos — Fase 3: REHACER una actividad (juego SCORM / práctica H5P, video H5P, presentación de
 * Gamma, audio de bienvenida o audiolibro) con los GENERADORES EXISTENTES de Cursia.
 *
 * A diferencia de la Fase 2, el contenido nuevo necesita proveedores PAGOS (Anthropic, OpenAI TTS, Videogen, Gamma,
 * YouTube): se produce ANTES de aplicar, solo con una aprobación con tope (B5), y queda como un RESULTADO VALIDADO (un
 * artifact del Taller, solo servidor). El motor de parches (B4) inserta ese resultado con las mismas invariantes de
 * siempre; un resultado inválido o incompleto nunca se inserta (falla visible).
 *
 * Puro: tipos.
 */

export const REGEN_CODE_VERSION = 'b10-r0';

/** Operaciones de la Fase 3 (catálogo cerrado del motor). */
export const PHASE3_OPERATIONS = Object.freeze(['regenerate_scorm', 'regenerate_video', 'regenerate_gamma', 'regenerate_audio'] as const);
export type RegenOperation = (typeof PHASE3_OPERATIONS)[number];
export const isRegenOperation = (op: unknown): op is RegenOperation => typeof op === 'string' && (PHASE3_OPERATIONS as readonly string[]).includes(op);

export type RegenProvider = 'anthropic' | 'openai' | 'gamma' | 'videogen' | 'youtube';
export const REGEN_PROVIDERS: readonly RegenProvider[] = Object.freeze(['anthropic', 'openai', 'gamma', 'videogen', 'youtube'] as RegenProvider[]);

/** Plantillas del motor SCORM v2 (06b-scorm-templates.js, `SCORM_V2_TEMPLATES`): las «mecánicas» de un juego. */
export const SCORM_V2_TEMPLATE_IDS = Object.freeze(['equipar_escena', 'decision_consecuencia', 'sopa_letras', 'crucigrama', 'ruleta_preguntas', 'multicamino', 'armar_proceso'] as const);
export const SCORM_V2_ROOMS = 5;

/**
 * Lo que se rehace, resuelto contra el inventario de ESTE paquete (con lo verificable del «antes»). Lo arma
 * `regenTargetOf` (target.ts) sin red ni base.
 */
export type RegenTarget =
  | {
    op: 'regenerate_scorm'; engine: 'scorm_v2'; moduleId: number; chapterNumber: number; title: string; chapterTitle: string;
    /** Mecánica de cada sala (las del juego original si es del motor v2; si no, las que pidió el docente o la rotación del curso). */
    mechanics: string[];
    mechanicsSource: 'original' | 'request' | 'default';
    /** Salas del juego actual (null = no se pudo contar: motor anterior, «⚠️ Pendiente»…). */
    roomsBefore: number | null;
    pendingBefore: boolean;
  }
  | {
    op: 'regenerate_scorm'; engine: 'h5p_practice'; moduleId: number; chapterNumber: number; title: string; chapterTitle: string;
    /** Tipo H5P de la práctica actual (questionset / dragtext / blanks / branchingscenario): se conserva. */
    h5pType: string;
    mainLibrary: string;
  }
  | {
    op: 'regenerate_video'; moduleId: number; chapterNumber: number; title: string; chapterTitle: string;
    container: 'h5pactivity' | 'hvp';
    /** Entrega: YouTube (v3 lo exige; V1 con hvp usa enlaces de YouTube). */
    delivery: 'youtube';
    youtubeIdBefore: string | null;
    questionsBefore: number;
    /** El video actual trae pausas de reflexión (H5P v2, `ivAdvanced`): el nuevo también. */
    advanced: boolean;
  }
  | {
    op: 'regenerate_gamma'; moduleId: number; chapterNumber: number; title: string; chapterTitle: string;
    pdfFile: string; coverFile: string; slidesBefore: number | null;
  }
  | {
    op: 'regenerate_audio'; moduleId: number; title: string;
    audio: 'welcome' | 'audiobook';
    /** Audiolibro: los capítulos del curso que tiene que narrar (TODOS: ninguno puede faltar). */
    chapters: number[];
    file: string;
    durationBefore: number | null;
  };

/** Resultado PRODUCIDO y validado (en memoria: Buffers). El motor lo vuelve a validar antes de insertarlo. */
export type ProducedRegen =
  | { kind: 'scorm_v2'; moduleId: number; chapterNumber: number; html: string; manifestXml: string; roomAssignment: string[]; rooms: number }
  | { kind: 'h5p_practice'; moduleId: number; chapterNumber: number; h5p: Buffer; mainLibrary: string; h5pType: string; questions: number }
  | {
    kind: 'video'; moduleId: number; chapterNumber: number; container: 'h5pactivity' | 'hvp';
    youtubeId: string; durationSec: number; interactions: number;
    /** v3: el `.h5p` nuevo (H5P.InteractiveVideo). V1: el `json_content` nuevo del hvp. */
    h5p: Buffer | null; hvpJson: string | null;
    /** Guion del video (narración por escena que informó Videogen): lo verificable del «después». */
    script: string; scenes: number;
    videogenJobId: string;
  }
  | {
    kind: 'presentation'; moduleId: number; chapterNumber: number; pdf: Buffer; cover: Buffer; slideCount: number;
    width: number; height: number; language: 'es-419'; generationId: string;
  }
  /** r107 B10 · Libro v3: el PDF que armó el builder con el markdown aprobado (se guarda igual que un resultado). */
  | { kind: 'libro_pdf'; moduleId: number; pdf: Buffer; previousSha1: string; chapters: number[] }
  | {
    kind: 'audio'; moduleId: number; audio: 'welcome' | 'audiobook'; mp3: Buffer; durationSec: number;
    bitrateKbps: number | null; channels: number | null;
    /** Audiolibro: un registro por capítulo narrado (número, palabras del guion, segundos). Bienvenida: []. */
    chapters: Array<{ number: number; words: number; seconds: number; scriptSha256: string }>;
    scriptWords: number;
  };

/**
 * Parámetros de la operación del motor (lo que se guarda en el plan): SIN los bytes. El resultado viaja como artifact
 * del Taller (`result`) y el trabajo de aplicar lo carga en `produced` (verificando su sha256) antes de llamar al motor.
 */
export interface RegenerateOp {
  op: RegenOperation;
  moduleId: number;
  /** Precondición: sha1 de los blobs / campos que se reemplazan (los del inventario al planear). */
  expect: { contenthashes: string[]; jsonSha1?: string | null };
  /** Lo verificable (para la vista y la huella del ítem). */
  summary: Record<string, unknown>;
  /** Resultado producido (artifact `workshop_regen_result`, solo servidor). */
  result?: { artifactId: string; sha256: string; bytes: number } | null;
  /** En memoria (nunca se persiste): el resultado ya cargado y verificado. */
  produced?: ProducedRegen | null;
}

/** Errores tipados de la producción (motivo en español). */
export type RegenErrorCode =
  | 'unavailable' | 'invalid_result' | 'cap_reached' | 'call_ambiguous' | 'provider_rejected' | 'provider_not_ready'
  | 'not_sent' | 'source_missing' | 'internal';

export class RegenError extends Error {
  constructor(readonly code: RegenErrorCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RegenError';
  }
}
