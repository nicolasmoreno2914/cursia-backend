/**
 * r107 B11 · Taller de cursos — Fase 4: AGREGAR un capítulo (`add_chapter`) o un módulo (`add_module`).
 *
 * El capítulo nuevo lleva el PATRÓN COMPLETO del builder que armó el curso, con las mismas piezas y el mismo orden. El
 * molde es un capítulo hermano del MISMO paquete (lo armó ese builder): de él salen la estructura Moodle (module.xml,
 * grades.xml, roles…) y las piezas que el builder arma con una plantilla fija (tarjeta de la presentación, introducción
 * del video, CTA «🎯 Practicar — Cap N»). El contenido nuevo lo producen los generadores EXISTENTES por la compuerta de la
 * aprobación (B10): el capítulo del Libro (`sysL` + `pLibro`), las páginas del capítulo (`sysH` + `pHTML`), el juego
 * (motor SCORM v2), el video (Videogen + preguntas) y la presentación (Gamma). El motor de parches inserta el resultado
 * validado con ids nuevos, numeración recalculada y todo o nada: una pieza que falta o no valida → nada se aplica.
 *
 * Puro: tipos.
 */

export const CHAPTER_CODE_VERSION = 'b11-r0';

/** Piezas del capítulo (roles del inventario de B2). */
export type ChapterPiece = 'presentation' | 'text' | 'video' | 'cta' | 'game';
/** Piezas que el docente puede pedir SIN («sin video», «sin Gamma»): el plan lo muestra. */
export const OMITTABLE_PIECES = Object.freeze(['presentation', 'video'] as const);
export type OmittablePiece = (typeof OMITTABLE_PIECES)[number];

/** Familias donde el Taller sabe armar un capítulo con el patrón de su builder. */
export const ADD_CHAPTER_FAMILIES = Object.freeze(['v1-legacy', 'v1-legacy-hvp'] as const);

/** Motivo visible cuando el formato del curso no admite agregar capítulos todavía (v3 y familias sin molde). */
export const V3_ADD_CHAPTER_UNAVAILABLE = 'En los cursos armados con el builder 3.x un capítulo lleva piezas que el Taller todavía no produce (experiencia del capítulo con sus 7 textos, repaso, actividad de aplicación con solucionario, práctica guiada, Libro en línea y el PDF del Libro rearmado): agregar capítulos en este formato no está disponible todavía. Nunca se agrega un capítulo con piezas de menos.';

/** Lo que se produjo para UN capítulo nuevo (en memoria: Buffers). El motor lo vuelve a validar antes de insertarlo. */
export interface ProducedChapter {
  kind: 'chapter';
  /** Número que tendrá el capítulo en el curso (los posteriores suben uno). */
  chapterNumber: number;
  title: string;
  /** Markdown del capítulo del Libro Guía (generador del Libro: `sysL` + `pLibro`). */
  libroMd: string;
  /** Páginas del capítulo (generador de páginas: `sysH` + `pHTML`): la del video (`vi`) y la del juego (`sc`). */
  videoPageHtml: string | null;
  gamePageHtml: string | null;
  /** Juego SCORM v2 (5 salas completas). */
  scorm: { html: string; manifestXml: string; roomAssignment: string[]; rooms: number };
  /** Video interactivo (hvp): contenido nuevo + lo verificable. null = el capítulo va sin video. */
  video: { hvpJson: string; youtubeId: string; durationSec: number; interactions: number; script: string; scenes: number; videogenJobId: string } | null;
  /** Presentación de Gamma: null = el capítulo va sin presentación. */
  presentation: { pdf: Buffer; cover: Buffer; slideCount: number; width: number; height: number; language: 'es-419'; generationId: string } | null;
}

/** Examen GIFT por unidad de un módulo nuevo (generador de exámenes: `sysG` + `pGIFT`). */
export interface ProducedUnitExam {
  gift: string;
  /** Página informativa del examen (`pHTML` tipo `ex`). */
  infoHtml: string;
}

/** Parámetros de `add_chapter` (lo que se guarda en el plan): sin bytes. */
export interface AddChapterOp {
  op: 'add_chapter';
  /** Módulo (unidad) donde va el capítulo. */
  moduleNumber: number;
  /** Número que tendrá el capítulo nuevo (los de ese número en adelante suben uno). */
  position: number;
  title: string;
  objective?: string | null;
  /** Capítulo hermano del mismo paquete que sirve de molde, y sus actividades (precondición). */
  templateChapter: number;
  expect: { templateModuleIds: number[] };
  /** Piezas omitidas a pedido («sin video», «sin Gamma»). */
  omit?: OmittablePiece[];
  /** Lo verificable (vista y huella). */
  summary?: Record<string, unknown>;
  result?: { artifactId: string; sha256: string; bytes: number } | null;
  /** En memoria (nunca se persiste). */
  produced?: ProducedChapter | null;
}

/** Parámetros de `add_module`: sección nueva con N capítulos (cada uno con el patrón de `add_chapter`) + su examen. */
export interface AddModuleOp {
  op: 'add_module';
  /** Número del módulo nuevo (va después del último). */
  moduleNumber: number;
  title: string;
  chapters: Array<{ title: string; objective?: string | null }>;
  /** Molde: el último capítulo del curso y el examen de su unidad (precondición). */
  templateChapter: number;
  templateExamModuleId: number | null;
  expect: { templateModuleIds: number[] };
  omit?: OmittablePiece[];
  summary?: Record<string, unknown>;
  result?: { artifactId: string; sha256: string; bytes: number } | null;
  produced?: ProducedModule | null;
}

export interface ProducedModule {
  kind: 'module';
  moduleNumber: number;
  title: string;
  chapters: ProducedChapter[];
  exam: ProducedUnitExam | null;
}

export const isChapterOperation = (op: unknown): op is 'add_chapter' | 'add_module' => op === 'add_chapter' || op === 'add_module';
