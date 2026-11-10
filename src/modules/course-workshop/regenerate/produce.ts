/**
 * r107 B10 · Fase 3 — orquesta UNA regeneración: destino → fuente → producción con el generador existente (por la
 * compuerta) → resultado validado. Puro respecto de la base: el servicio le pasa el lector del paquete, la fuente de la
 * base (si el curso está identificado), los proveedores y la compuerta de la aprobación.
 */
import type { DryRunPricing } from '../../pedagogy/dry-run';
import type { WorkshopCourse } from '../course-model';
import { produceAudio, welcomeTextOf } from './audio';
import { AUDIOBOOK_FLOOR_MINUTES, AUDIOBOOK_FLOOR_SOURCE_WORDS, AUDIOBOOK_TARGET_RATIO, AUDIOBOOK_WPM_REF } from '../../../package/audio/audiobook-policy';
import { RegenPlannedCall, estimateRegen } from './estimate';
import { produceGamma } from './gamma';
import { regenLlmSizes } from './llm-sizes';
import { PaidCallGate, RegenProviders } from './ports';
import { producePracticeH5p, produceScormV2 } from './scorm';
import { ChapterSource, ORIGIN_ES, RegenDbSources, chapterSources } from './sources';
import { Reader, RegenTargetInput, regenTargetOf } from './target';
import { ProducedRegen, RegenError, RegenExternal, RegenOperation, RegenTarget } from './types';
import { produceVideo } from './video';

/** Modelo de IA del generador (DYN_GENERATION_MODEL del ejecutor y default del guion del audiolibro): lo fija Cursia. */
export const REGEN_LLM_MODEL = 'claude-sonnet-4-6';

export function chaptersNeeded(t: RegenTarget): number[] {
  switch (t.op) {
    case 'regenerate_scorm': return t.engine === 'h5p_practice' ? [t.chapterNumber] : [];
    case 'regenerate_video': case 'regenerate_gamma': return [t.chapterNumber];
    case 'regenerate_audio': return t.audio === 'audiobook' ? t.chapters : [];
  }
  return [];
}

export interface RegenResolved {
  target: RegenTarget;
  expect: { contenthashes: string[]; jsonSha1?: string | null };
  sources: ChapterSource[];
  /** Lo que el docente ve ANTES de aprobar: qué se rehace, de qué fuente, con qué mecánica. */
  notes: string[];
}

/** Destino + fuente, SIN gastar. `unavailable` = no se puede rehacer (motivo visible) y no se cobra nada. */
export async function resolveRegen(i: RegenTargetInput & { db: RegenDbSources | null }): Promise<RegenResolved | { unavailable: string }> {
  const r = await regenTargetOf(i);
  if ('unavailable' in r) return r;
  const t = r.target;
  const need = chaptersNeeded(t);
  const { sources, missing } = await chapterSources(i.course, need, i.read, i.db);
  if (missing.length) {
    return { unavailable: t.op === 'regenerate_audio'
      ? `No hay texto para ${missing.length === 1 ? `el capítulo ${missing[0]}` : `los capítulos ${missing.join(', ')}`} (ni en Cursia ni en el paquete): un audiolibro no se arma con capítulos de menos.`
      : `No hay texto del capítulo ${missing.join(', ')} (ni en Cursia ni en el paquete) para rehacerlo.` };
  }
  if (t.op === 'regenerate_scorm' && t.engine === 'h5p_practice' && !i.db?.contextPackage.get(t.chapterNumber)) {
    return { unavailable: `La práctica H5P de este curso se arma con el Context Package del capítulo guardado en Cursia, y no está disponible (${i.db?.unavailable ? i.db.unavailable.replace(/\.$/, '') : 'curso sin identificar o sin su fuente'}): no se puede rehacer.` };
  }
  // Fix round 1 (P2-5): el audiolibro COMPLETO tiene el piso del dueño (r19: ≥ 25 min) ANTES de pagar nada.
  if (t.op === 'regenerate_audio' && t.audio === 'audiobook') {
    const total = sources.reduce((a, s) => a + s.words, 0);
    if (total < AUDIOBOOK_FLOOR_SOURCE_WORDS) {
      const minutes = Math.floor((total * AUDIOBOOK_TARGET_RATIO / AUDIOBOOK_WPM_REF) * 10) / 10;
      return { unavailable: `El texto de los ${sources.length} capítulo(s) (${total} palabras) da un audiolibro de ~${minutes} min, por debajo del mínimo de ${AUDIOBOOK_FLOOR_MINUTES} min (hacen falta al menos ${AUDIOBOOK_FLOOR_SOURCE_WORDS} palabras de fuente): no se paga un audiolibro corto.` };
    }
  }
  if (t.op === 'regenerate_audio' && t.audio === 'welcome' && !welcomeTextOf(i.course)) return { unavailable: 'El curso no tiene un texto de bienvenida para narrar.' };
  const notes: string[] = [];
  for (const s of sources) notes.push(`Capítulo ${s.number}: se usa ${ORIGIN_ES[s.origin]} (${s.words} palabras).`);
  if (t.op === 'regenerate_scorm' && t.engine === 'scorm_v2') {
    notes.push(t.mechanicsSource === 'original' ? `Mismas mecánicas del juego actual, sala por sala: ${t.mechanics.join(', ')}.`
      : t.mechanicsSource === 'request' ? `Mecánicas que pediste: ${t.mechanics.join(', ')}.`
        : `El juego actual no es del motor de juegos vigente${t.pendingBefore ? ' (tiene «⚠️ Pendiente»)' : ''}: se rehace con la rotación de mecánicas del curso (${t.mechanics.length} plantillas).`);
  }
  return { target: t, expect: r.expect, sources, notes };
}

export function regenEstimate(res: RegenResolved, course: WorkshopCourse, pricing: DryRunPricing, ttsModel: string, db: RegenDbSources | null = null): RegenPlannedCall {
  const llmSizes = regenLlmSizes(res.target, { course, db, sources: res.sources });
  return estimateRegen(res.target, { pricing, llmModel: REGEN_LLM_MODEL, ttsModel, sources: res.sources, llmSizes, welcomeChars: res.target.op === 'regenerate_audio' && res.target.audio === 'welcome' ? (welcomeTextOf(course)?.length ?? null) : null });
}

/** Produce el resultado (gasta por la compuerta). Lanza RegenError con el motivo; nunca devuelve algo a medias. */
export async function produceRegen(a: { res: RegenResolved; course: WorkshopCourse; read: Reader; providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; db: RegenDbSources | null; ext?: RegenExternal }): Promise<ProducedRegen> {
  const t = a.res.target;
  const md = (n: number) => a.res.sources.find((s) => s.number === n)?.md ?? '';
  switch (t.op) {
    case 'regenerate_scorm': {
      if (t.engine === 'scorm_v2') return produceScormV2({ target: t, course: a.course, providers: a.providers, gate: a.gate, pricing: a.pricing, db: a.db });
      const act = a.course.activities.find((x) => x.moduleId === t.moduleId);
      const f = act?.files.find((x) => x.filearea === 'package' && /\.h5p$/i.test(x.filename));
      const cur = f ? await a.read(f.blobEntry) : null;
      if (!cur) throw new RegenError('unavailable', 'La práctica actual no trae su .h5p.');
      return producePracticeH5p({ target: t, course: a.course, providers: a.providers, gate: a.gate, pricing: a.pricing, db: a.db, chapterMd: md(t.chapterNumber), currentH5p: cur });
    }
    case 'regenerate_video': return produceVideo({ target: t, course: a.course, providers: a.providers, gate: a.gate, pricing: a.pricing, db: a.db, chapterMd: md(t.chapterNumber), ext: a.ext });
    case 'regenerate_gamma': return produceGamma({ target: t, providers: a.providers, gate: a.gate, pricing: a.pricing, chapterMd: md(t.chapterNumber), ext: a.ext });
    case 'regenerate_audio': return produceAudio({ target: t, course: a.course, providers: a.providers, gate: a.gate, pricing: a.pricing, sources: a.res.sources });
  }
  throw new RegenError('unavailable', 'Operación fuera del catálogo.');
}

export const OP_ES: Record<RegenOperation, string> = {
  regenerate_scorm: 'Rehacer el juego', regenerate_video: 'Rehacer el video', regenerate_gamma: 'Rehacer la presentación', regenerate_audio: 'Rehacer el audio',
};

/** «Antes» verificable del destino (para la vista del plan). */
export function beforeFacts(t: RegenTarget): Record<string, unknown> {
  switch (t.op) {
    case 'regenerate_scorm': return t.engine === 'scorm_v2'
      ? { kind: 'scorm_v2', rooms: t.roomsBefore, mechanics: t.mechanicsSource === 'original' ? t.mechanics : null, pending: t.pendingBefore }
      : { kind: 'h5p_practice', h5pType: t.h5pType, mainLibrary: t.mainLibrary };
    case 'regenerate_video': return { kind: 'video', container: t.container, youtubeId: t.youtubeIdBefore, questions: t.questionsBefore };
    case 'regenerate_gamma': return { kind: 'presentation', slides: t.slidesBefore, pdf: t.pdfFile, cover: t.coverFile };
    case 'regenerate_audio': return { kind: 'audio', audio: t.audio, durationSec: t.durationBefore, chapters: t.chapters, file: t.file };
  }
  return {};
}
