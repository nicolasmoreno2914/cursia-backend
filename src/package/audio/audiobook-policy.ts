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

// ─────────────────────────────────────────────────────────────────────────────
// r67 (A1/A2): recuperación ADAPTATIVA de un segmento con ritmo fuera de banda.
// La banda aceptada (115–175 ppm) NO cambia. Antes, un segmento rápido (R1-bis: 181,1 y 186,5 ppm) se
// re-sintetizaba igual 3 veces (mismo texto, modelo, voz, sin parámetros) y fallaba igual. Ahora:
//  1. corrección LOCAL del ritmo (ffmpeg atempo sobre el MP3 crudo de OpenAI, USD 0) si el factor cabe en
//     [ATEMPO_MIN, ATEMPO_MAX] y el resultado pasa la verificación de integridad;
//  2. si no: escalera de re-síntesis con estrategias DISTINTAS que nunca se repiten (instructions → split → speed
//     solo si el modelo lo soporta) y, agotada, falla definitiva visible (AUDIO_STRATEGIES_EXHAUSTED).
// Puro: constantes y decisiones sobre números ya medidos.
// ─────────────────────────────────────────────────────────────────────────────

/** r67: ritmo objetivo al corregir un segmento demasiado RÁPIDO (> AUDIOBOOK_WPM_MAX). */
export const AUDIOBOOK_WPM_TARGET = 165;
/** r67: ritmo objetivo al corregir un segmento demasiado LENTO (< AUDIOBOOK_WPM_MIN). */
export const AUDIOBOOK_WPM_TARGET_SLOW = 125;
/**
 * r67: límites del factor de atempo (fuera → re-síntesis; una desviación grande puede ser texto omitido, nunca se tapa).
 * Solo se usa el lado < 1 (frenar): un segmento lento nunca se acelera localmente (ver atempoPlanFor). MAX queda como cota
 * de `atempoFilterChain`/documentación.
 */
export const AUDIOBOOK_ATEMPO_MIN = 0.85;
export const AUDIOBOOK_ATEMPO_MAX = 1.15;
/** r67: tolerancia de la duración corregida frente a la esperada (duración original / factor). */
export const AUDIO_RETIME_DURATION_TOLERANCE = 0.03;
/** r67: silencio interno más largo admitido que el original no tenía (s). */
export const AUDIO_INTERNAL_SILENCE_MAX_SECONDS = 2;
/** r67: pico máximo (dBFS) — por encima se considera clipping. */
export const AUDIO_PEAK_MAX_DBFS = -0.5;

export interface AtempoPlan {
  /** Ritmo objetivo (165 si rápido, 125 si lento). */
  targetWpm: number;
  /** factor = objetivo / actual (< 1 frena, > 1 acelera). */
  factor: number;
  /** ¿Se permite la corrección local? Solo segmentos RÁPIDOS con factor en [ATEMPO_MIN, 1). */
  withinLimits: boolean;
  /** r67: segmento demasiado lento (< AUDIOBOOK_WPM_MIN): nunca se corrige localmente. */
  slow: boolean;
}

/** r67: plan de corrección local para un ritmo medido fuera de banda; null si el ritmo está dentro de la banda. */
export function atempoPlanFor(wpm: number): AtempoPlan | null {
  if (!(wpm > 0)) return null;
  if (wpm >= AUDIOBOOK_WPM_MIN && wpm <= AUDIOBOOK_WPM_MAX) return null;
  const slow = wpm < AUDIOBOOK_WPM_MIN;
  const targetWpm = slow ? AUDIOBOOK_WPM_TARGET_SLOW : AUDIOBOOK_WPM_TARGET;
  const factor = Math.round((targetWpm / wpm) * 1e6) / 1e6;
  // r67 (decisión del PO): solo se FRENA localmente un segmento demasiado rápido (factor en [0,85; 1)). Un segmento
  // demasiado LENTO (< 115) nunca se acelera: puede ser relleno/silencio o bucle y acelerarlo lo taparía → re-síntesis.
  return { targetWpm, factor, slow, withinLimits: !slow && factor >= AUDIOBOOK_ATEMPO_MIN && factor < 1 };
}

/**
 * r67: cadena de filtros atempo para un factor (ffmpeg admite 0,5–100 por filtro; fuera de [0,5; 2] se encadena).
 * Con los límites actuales (0,85–1,15) siempre es un solo filtro; la cadena queda por robustez.
 */
export function atempoFilterChain(factor: number): string {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new Error(`factor de atempo inválido: ${factor}`);
  const parts: string[] = [];
  let f = factor;
  while (f < 0.5) { parts.push('atempo=0.5'); f /= 0.5; }
  while (f > 2) { parts.push('atempo=2'); f /= 2; }
  parts.push(`atempo=${Number(f.toFixed(6))}`);
  return parts.join(',');
}

/** r67 (A2): estrategias de re-síntesis, en orden. `base` = la síntesis original (primera vez). */
export type AudioSynthStrategy = 'base' | 'instructions' | 'split' | 'speed';
export const AUDIO_RETRY_LADDER: readonly AudioSynthStrategy[] = Object.freeze(['instructions', 'split', 'speed'] as AudioSynthStrategy[]);
/** r67: instrucción de ritmo para gpt-4o-mini-tts (`instructions` NO funciona con tts-1/tts-1-hd). */
export const AUDIO_PACE_INSTRUCTIONS = 'Narra a un ritmo pausado y claro, aproximadamente 150 palabras por minuto.';
/** r67: velocidad de la estrategia `speed` (solo si el modelo la soporta de forma verificada). */
export const AUDIO_SPEED_STRATEGY_VALUE = 0.9;

/**
 * r67: ¿el modelo respeta `speed`? La documentación oficial no lo confirma para gpt-4o-mini-tts (solo lo documenta en
 * general, 0,25–4,0) → NO verificado → la estrategia `speed` se salta (spec A2.3). Un modelo tts-1/tts-1-hd sí lo
 * documenta, pero ahí `instructions` no aplica: tampoco se usa en este pipeline.
 */
export function ttsModelSupportsSpeed(model: string): boolean {
  void model;
  return false;
}

/** r67: ¿el modelo soporta `instructions`? (gpt-4o-mini-tts sí; tts-1 / tts-1-hd no). */
export function ttsModelSupportsInstructions(model: string): boolean {
  return /^gpt-4o(-mini)?-tts/.test(String(model || ''));
}

/** Intento de una estrategia sobre un segmento (output_summary.audioRetryStrategy[segKey].tried[]). */
export interface AudioStrategyTry {
  strategy: AudioSynthStrategy;
  /** sha del texto enviado (misma entrada + misma estrategia = falla determinista → no se repite). */
  textSha: string;
  attempt: number;
  wpm: number | null;
  outcome: 'wpm_out_of_range' | 'integrity_failed' | 'accepted';
  at: string;
}

export interface AudioRetryState {
  tried: AudioStrategyTry[];
  /** Estrategia a aplicar en la próxima síntesis de este segmento (null = escalera agotada). */
  next: AudioSynthStrategy | null;
  exhausted: boolean;
}

/** r67: siguiente estrategia de la escalera que NO se probó con este mismo texto (null = agotada). */
export function nextAudioStrategy(tried: ReadonlyArray<Pick<AudioStrategyTry, 'strategy' | 'textSha'>>, textSha: string, model: string): AudioSynthStrategy | null {
  const done = new Set(tried.filter((t) => t.textSha === textSha).map((t) => t.strategy));
  for (const s of AUDIO_RETRY_LADDER) {
    if (done.has(s)) continue;
    if (s === 'instructions' && !ttsModelSupportsInstructions(model)) continue;
    if (s === 'speed' && !ttsModelSupportsSpeed(model)) continue;
    return s;
  }
  return null;
}

/** r67: estrategia que corresponde a la próxima síntesis de un segmento (base si nunca falló con este texto). */
export function currentAudioStrategy(state: AudioRetryState | null | undefined, textSha: string, model: string): AudioSynthStrategy | null {
  const tried = (state?.tried ?? []).filter((t) => t.textSha === textSha);
  if (!tried.length) return 'base';
  return nextAudioStrategy(tried, textSha, model);
}

/** r67: estrategias que quedan para un segmento (para el tope de rondas del auto-heal). */
export function remainingAudioStrategies(state: AudioRetryState | null | undefined, textSha: string | null, model: string): number {
  const tried = (state?.tried ?? []).filter((t) => textSha === null || t.textSha === textSha);
  const done = new Set(tried.map((t) => t.strategy));
  return AUDIO_RETRY_LADDER.filter((s) => !done.has(s)
    && !(s === 'instructions' && !ttsModelSupportsInstructions(model))
    && !(s === 'speed' && !ttsModelSupportsSpeed(model))).length;
}

/**
 * r67 (split): parte el texto de un segmento en 2 por oración, lo más parejo posible en palabras. Sin un límite de
 * oración aprovechable, por palabras a la mitad. Nunca devuelve una parte vacía; la concatenación de las partes con
 * un espacio reproduce el texto (normalizado por espacios).
 */
export function splitSegmentTextInTwo(text: string): [string, string] {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  const sentences = t.split(/(?<=[.!?…;:])\s+/).filter(Boolean);
  const wc = (s: string) => (s ? s.split(' ').length : 0);
  if (sentences.length >= 2) {
    const total = wc(t);
    let best = 1;
    let bestDiff = Infinity;
    let acc = 0;
    for (let i = 1; i < sentences.length; i++) {
      acc += wc(sentences[i - 1]);
      const d = Math.abs(total - 2 * acc);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return [sentences.slice(0, best).join(' '), sentences.slice(best).join(' ')];
  }
  const w = t.split(' ');
  if (w.length < 2) throw new Error('splitSegmentTextInTwo: el segmento tiene menos de 2 palabras');
  const h = Math.ceil(w.length / 2);
  return [w.slice(0, h).join(' '), w.slice(h).join(' ')];
}

/** Medición mínima de un MP3 para la verificación de integridad (frames del pipeline). */
export interface AudioMeasure {
  frames: number;
  seconds: number;
  bitrateKbps: number | null;
}

/** Análisis acústico (ffmpeg silencedetect + astats). null = no se pudo analizar (sin ffmpeg / error). */
export interface AudioAnalysis {
  durationSeconds: number | null;
  silences: Array<{ start: number; end: number }>;
  peakDbfs: number | null;
}

export interface RetimeIntegrityInput {
  factor: number;
  /** Medición del original (ya en el bitrate del pipeline) y del corregido. */
  original: AudioMeasure;
  retimed: AudioMeasure | null;
  analysisOriginal: AudioAnalysis | null;
  analysisRetimed: AudioAnalysis | null;
  /** Bitrate esperado del pipeline (48 kbps del audiolibro). */
  kbps: number;
  /** Palabras del segmento (re-medición del ritmo). */
  words: number;
}

export interface RetimeIntegrityResult {
  ok: boolean;
  wpm: number | null;
  expectedSeconds: number;
  problems: string[];
}

const EDGE_EPS_S = 0.05;
function internalSilences(a: AudioAnalysis, totalSeconds: number): Array<{ start: number; end: number }> {
  return a.silences.filter((s) => s.start > EDGE_EPS_S && s.end < totalSeconds - EDGE_EPS_S && s.end - s.start > AUDIO_INTERNAL_SILENCE_MAX_SECONDS);
}

/**
 * r67 (A1.5): verificación DURA del segmento corregido antes de aceptarlo. Todo debe cumplirse:
 *  - MP3 parseable con frames de audio (medición del pipeline);
 *  - duración ≈ original / factor (±3 %);
 *  - ritmo re-medido dentro de 115–175;
 *  - bitrate = el del pipeline;
 *  - análisis acústico disponible (sin análisis no se acepta: nunca un éxito sin verificar);
 *  - sin silencios internos > 2 s que el original no tuviera; sin clipping (pico ≤ −0,5 dBFS).
 */
export function evaluateRetimeIntegrity(x: RetimeIntegrityInput): RetimeIntegrityResult {
  const problems: string[] = [];
  const expectedSeconds = x.original.seconds / x.factor;
  if (!x.retimed || !(x.retimed.frames > 0) || !(x.retimed.seconds > 0)) {
    return { ok: false, wpm: null, expectedSeconds, problems: ['RETIME_UNPARSEABLE'] };
  }
  const r = x.retimed;
  const wpm = Math.round((x.words / (r.seconds / 60)) * 10) / 10;
  if (Math.abs(r.seconds - expectedSeconds) > AUDIO_RETIME_DURATION_TOLERANCE * expectedSeconds) {
    problems.push(`RETIME_DURATION ${r.seconds.toFixed(2)} s vs ${expectedSeconds.toFixed(2)} s esperados`);
  }
  if (x.words >= AUDIOBOOK_WPM_MIN_WORDS && (wpm < AUDIOBOOK_WPM_MIN || wpm > AUDIOBOOK_WPM_MAX)) problems.push(`RETIME_WPM ${wpm}`);
  if (r.bitrateKbps !== x.kbps) problems.push(`RETIME_BITRATE ${r.bitrateKbps ?? 'VBR'} != ${x.kbps}`);
  if (!x.analysisRetimed || !x.analysisOriginal) {
    problems.push('RETIME_ANALYSIS_UNAVAILABLE');
  } else {
    const before = internalSilences(x.analysisOriginal, x.original.seconds).length;
    const after = internalSilences(x.analysisRetimed, r.seconds).length;
    if (after > before) problems.push(`RETIME_NEW_INTERNAL_SILENCE ${after - before}`);
    if (x.analysisRetimed.peakDbfs === null) problems.push('RETIME_PEAK_UNKNOWN');
    else if (x.analysisRetimed.peakDbfs > AUDIO_PEAK_MAX_DBFS) problems.push(`RETIME_CLIPPING ${x.analysisRetimed.peakDbfs} dBFS`);
    if (typeof x.analysisRetimed.durationSeconds === 'number'
      && Math.abs(x.analysisRetimed.durationSeconds - r.seconds) > AUDIO_RETIME_DURATION_TOLERANCE * r.seconds) {
      problems.push(`RETIME_DECODED_DURATION ${x.analysisRetimed.durationSeconds.toFixed(2)} s vs ${r.seconds.toFixed(2)} s por frames`);
    }
  }
  return { ok: problems.length === 0, wpm, expectedSeconds, problems };
}
