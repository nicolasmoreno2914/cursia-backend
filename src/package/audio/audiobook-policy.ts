/**
 * audiobook-policy.ts
 *
 * r19 (bloque A): política del audiolibro COMPLETO de un curso dinámico (v3).
 *
 * Antes (heredado de V1): cada capítulo se narraba como un RESUMEN de ~480
 * palabras escrito desde los primeros 2.200 caracteres del capítulo (≈13 %).
 * Con 2–4 capítulos el audiolibro duraba 7–14 min. Ahora cada capítulo se
 * narra completo, bloque por bloque (`##`), adaptado para escuchar (≈90 % de
 * las palabras de la fuente), y el audiolibro de un curso de volumen normal
 * dura ≥ 25 min sin relleno, sin silencios y sin bajar la velocidad.
 *
 * Puro: solo constantes y validaciones sobre números ya medidos.
 */

/** Ritmo medido de la voz (`marin`, gpt-4o-mini-tts): 137–145 ppm en las bienvenidas de #625/#616 (DIAG-A §1). */
export const AUDIOBOOK_WPM_REF = 141;
/** Palabras del guion / palabras de la fuente del bloque: objetivo y banda aceptada. */
export const AUDIOBOOK_TARGET_RATIO = 0.9;
export const AUDIOBOOK_MIN_RATIO = 0.85;
export const AUDIOBOOK_MAX_RATIO = 1.1;
/** Piso de duración de un curso de volumen normal. */
export const AUDIOBOOK_FLOOR_MINUTES = 25;
export const AUDIOBOOK_FLOOR_SECONDS = AUDIOBOOK_FLOOR_MINUTES * 60;
/**
 * Umbral de "volumen normal" en palabras de fuente narrables: las que, narradas
 * al ratio MÍNIMO aceptado y al ritmo medido, llenan el piso:
 * ceil(25 min × 141 ppm / 0.85) = 4.148 palabras (≈ 1,5 capítulos dinámicos de
 * ~2.800). Por debajo, el audiolibro sigue al contenido (sin relleno).
 */
export const AUDIOBOOK_FLOOR_SOURCE_WORDS = Math.ceil((AUDIOBOOK_FLOOR_MINUTES * AUDIOBOOK_WPM_REF) / AUDIOBOOK_MIN_RATIO);
/**
 * Banda de ritmo aceptada por segmento (palabras enviadas / minutos medidos de
 * frames): atrapa voz ralentizada, relleno con silencio o audio en bucle. Solo
 * se aplica con ≥ AUDIOBOOK_WPM_MIN_WORDS palabras (con menos, el redondeo del
 * último frame domina).
 */
export const AUDIOBOOK_WPM_MIN = 115;
export const AUDIOBOOK_WPM_MAX = 175;
export const AUDIOBOOK_WPM_MIN_WORDS = 60;
/** Bitrate del audiolibro (voz, mono): 72 min ≈ 26 MB. La bienvenida y el resto del audio no cambian (64 kbps). */
export const AUDIOBOOK_TARGET_BITRATE_KBPS = 48;
/** Versión del manifiesto por capítulo (`audiobookManifest`). */
export const AUDIOBOOK_MANIFEST_VERSION = 1;

export class AudiobookPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AudiobookPolicyError';
  }
}

/** Duración (s) esperada de `words` palabras narradas al ritmo medido. */
export function expectedSecondsForWords(words: number): number {
  return (words * 60) / AUDIOBOOK_WPM_REF;
}

export interface AudiobookManifestSegment {
  key: string;
  sectionIdx: number;
  partIdx: number;
  words: number;
  chars: number;
  textSha: string;
  audioSha: string;
  frames: number;
  seconds: number;
  bitrateKbps: number | null;
  requestId: string | null;
  storagePath: string;
}

export interface AudiobookManifestSection {
  idx: number;
  title: string;
  sourceWords: number;
  sourceSha: string;
  scriptWords: number;
  ratio: number;
  continued: boolean;
  messageIds: string[];
}

/** Manifiesto de UN capítulo del audiolibro (se guarda en el artifact y en el summary del item). */
export interface AudiobookChapterManifest {
  v: number;
  chapterId: string;
  source: {
    words: number;
    narratableWords: number;
    sections: number;
    sha256: string;
    /** Secciones excluidas EXPLÍCITAMENTE de la narración (bibliografía), con sus palabras. */
    excluded: Array<{ title: string; words: number; reason: string }>;
    /** Fix round 1 (I3): palabras del Markdown crudo y las que no quedaron en ningún bloque ni excluido. */
    rawWords?: number | null;
    lostWords?: number | null;
  };
  script: { words: number; ratio: number; sections: AudiobookManifestSection[] };
  tts: {
    wordsSent: number;
    charsSent: number;
    segmentsExpected: number;
    segmentsGenerated: number;
    segmentsConcatenated: number;
    segments: AudiobookManifestSegment[];
  };
  audio: {
    frames: number;
    seconds: number;
    infoFrames: number | null;
    infoFrameSeconds: number | null;
    bitrateKbps: number | null;
    wpm: number;
    /** Fix round 1 (I1): duración mínima del capítulo = 0,85 × palabras narrables × 60 / 141. */
    targetSeconds?: number;
  };
}

const FRAME_EPS = 1e-6;

/**
 * Validación DURA del manifiesto de un capítulo antes de completar el item.
 * Devuelve la lista de problemas (vacía = completo). Nunca "casi completo".
 */
export function validateChapterAudioManifest(m: AudiobookChapterManifest): string[] {
  const errs: string[] = [];
  if (!m || m.v !== AUDIOBOOK_MANIFEST_VERSION) return ['MANIFEST_VERSION'];
  const t = m.tts;
  if (!(t.segmentsExpected > 0)) errs.push('SEGMENTS_NONE');
  if (t.segmentsExpected !== t.segmentsGenerated) errs.push(`SEGMENTS_GENERATED ${t.segmentsGenerated}/${t.segmentsExpected}`);
  if (t.segmentsExpected !== t.segmentsConcatenated) errs.push(`SEGMENTS_CONCATENATED ${t.segmentsConcatenated}/${t.segmentsExpected}`);
  if (t.segments.length !== t.segmentsExpected) errs.push(`SEGMENTS_LISTED ${t.segments.length}/${t.segmentsExpected}`);
  const textShas = new Set<string>();
  const audioShas = new Set<string>();
  for (const s of t.segments) {
    if (textShas.has(s.textSha)) errs.push(`SEGMENT_TEXT_DUPLICATE ${s.key}`);
    if (audioShas.has(s.audioSha)) errs.push(`SEGMENT_AUDIO_DUPLICATE ${s.key}`);
    textShas.add(s.textSha);
    audioShas.add(s.audioSha);
    if (!(s.frames > 0)) errs.push(`SEGMENT_EMPTY ${s.key}`);
  }
  const frameSum = t.segments.reduce((a, s) => a + s.frames, 0);
  if (frameSum !== m.audio.frames) errs.push(`FRAMES_SUM ${m.audio.frames} != ${frameSum}`);
  const secSum = t.segments.reduce((a, s) => a + s.seconds, 0);
  if (Math.abs(secSum - m.audio.seconds) > FRAME_EPS * Math.max(1, t.segments.length)) errs.push(`SECONDS_SUM ${m.audio.seconds} != ${secSum}`);
  if (m.audio.infoFrames === null || m.audio.infoFrames !== m.audio.frames) errs.push(`INFO_FRAMES ${m.audio.infoFrames} != ${m.audio.frames}`);
  if (m.audio.infoFrameSeconds === null || Math.abs(m.audio.infoFrameSeconds - m.audio.seconds) > FRAME_EPS) errs.push(`INFO_SECONDS ${m.audio.infoFrameSeconds} != ${m.audio.seconds}`);
  for (const s of m.script.sections) {
    if (s.ratio < AUDIOBOOK_MIN_RATIO || s.ratio > AUDIOBOOK_MAX_RATIO) errs.push(`SECTION_RATIO ${s.idx}:${s.ratio}`);
  }
  if (m.script.sections.length !== m.source.sections) errs.push(`SECTIONS ${m.script.sections.length}/${m.source.sections}`);
  const sentWords = t.segments.reduce((a, s) => a + s.words, 0);
  if (sentWords !== t.wordsSent) errs.push(`WORDS_SENT ${t.wordsSent} != ${sentWords}`);
  if (t.wordsSent >= AUDIOBOOK_WPM_MIN_WORDS && (m.audio.wpm < AUDIOBOOK_WPM_MIN || m.audio.wpm > AUDIOBOOK_WPM_MAX)) errs.push(`WPM ${m.audio.wpm}`);
  if (typeof m.audio.targetSeconds === 'number' && m.audio.seconds + FRAME_EPS < m.audio.targetSeconds) errs.push(`UNDER_TARGET ${m.audio.seconds} < ${m.audio.targetSeconds}`);
  return errs;
}

export interface CourseFloorChapter {
  chapterId: string;
  durationSeconds: number;
  /**
   * null = audio real SIN manifiesto (curso existente, anterior a r19): el piso se omite CON aviso.
   * undefined = capítulo simulado (run mock): el piso se omite sin aviso.
   */
  manifest: Pick<AudiobookChapterManifest, 'source' | 'script' | 'tts' | 'audio'> | null | undefined;
}

export interface CourseFloorResult {
  checked: boolean;
  sourceWords: number | null;
  totalSeconds: number;
  floorSeconds: number;
  thresholdWords: number;
  belowFloor: boolean;
  warnings: string[];
}

/**
 * Piso de 25 min a nivel curso. Con manifiesto en TODOS los capítulos y
 * Σ palabras de fuente ≥ umbral, la duración total medida debe ser ≥ 25 min;
 * si no, AUDIOBOOK_TOO_SHORT_FOR_SOURCE con el diagnóstico por capítulo
 * (segmentos faltantes, bloques por debajo del objetivo, ritmo). Un capítulo
 * sin manifiesto (audio existente de antes de r19, o simulado) → el piso se
 * omite con un aviso: un re-empaque NUNCA re-narra ni gasta.
 * Fix round 1 (I1): es una defensa en profundidad. El worker del capítulo ya exige
 * `chapterTargetSeconds` (0,85 × palabras × 60/141) antes de completar, así que
 * con Σ fuente ≥ umbral el total es ≥ 1500 s por construcción; llegar aquí es un bug.
 */
export function checkAudiobookCourseFloor(chapters: CourseFloorChapter[]): CourseFloorResult {
  const totalSeconds = chapters.reduce((a, c) => a + c.durationSeconds, 0);
  const base = { totalSeconds, floorSeconds: AUDIOBOOK_FLOOR_SECONDS, thresholdWords: AUDIOBOOK_FLOOR_SOURCE_WORDS };
  if (chapters.some((c) => !c.manifest)) {
    const legacy = chapters.filter((c) => c.manifest === null).map((c) => c.chapterId);
    return { ...base, checked: false, sourceWords: null, belowFloor: false, warnings: legacy.map((id) => `audiobook_floor_skipped_no_manifest:${id}`) };
  }
  const sourceWords = chapters.reduce((a, c) => a + (c.manifest as NonNullable<CourseFloorChapter['manifest']>).source.narratableWords, 0);
  if (sourceWords < AUDIOBOOK_FLOOR_SOURCE_WORDS) {
    return { ...base, checked: true, sourceWords, belowFloor: true, warnings: [] };
  }
  if (totalSeconds + FRAME_EPS < AUDIOBOOK_FLOOR_SECONDS) {
    const diag = chapters.map((c) => {
      const m = c.manifest as NonNullable<CourseFloorChapter['manifest']>;
      const issues: string[] = [];
      if (m.tts.segmentsGenerated !== m.tts.segmentsExpected) issues.push(`segmentos ${m.tts.segmentsGenerated}/${m.tts.segmentsExpected}`);
      if (m.tts.segmentsConcatenated !== m.tts.segmentsExpected) issues.push(`concatenados ${m.tts.segmentsConcatenated}/${m.tts.segmentsExpected}`);
      const under = m.script.sections.filter((s) => s.ratio < AUDIOBOOK_TARGET_RATIO).map((s) => `${s.idx}:${s.ratio.toFixed(2)}`);
      if (under.length) issues.push(`bloques bajo el objetivo ${AUDIOBOOK_TARGET_RATIO} [${under.join(', ')}]`);
      issues.push(`ritmo ${m.audio.wpm.toFixed(0)} ppm`);
      return `${c.chapterId}: ${Math.round(c.durationSeconds)} s, fuente ${m.source.narratableWords} palabras, guion ${m.script.words} (${issues.join('; ')})`;
    });
    throw new AudiobookPolicyError(
      'AUDIOBOOK_TOO_SHORT_FOR_SOURCE',
      `el audiolibro dura ${Math.round(totalSeconds)} s (< ${AUDIOBOOK_FLOOR_SECONDS} s) con ${sourceWords} palabras de fuente ` +
        `(umbral ${AUDIOBOOK_FLOOR_SOURCE_WORDS}). Diagnóstico: ${diag.join(' | ')}. Regenera el audiolibro de los capítulos señalados.`,
    );
  }
  return { ...base, checked: true, sourceWords, belowFloor: false, warnings: [] };
}
