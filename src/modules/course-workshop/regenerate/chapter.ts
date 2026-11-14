/**
 * r107 B11 · Fase 4 — PRODUCIR un capítulo nuevo (o los de un módulo nuevo) con los GENERADORES EXISTENTES, por la
 * compuerta de la aprobación (B10: tope ≥ Σ cotas, `sent` antes de enviar, ambiguo nunca se reenvía):
 *   1. Libro Guía: `sysL()` + `pLibro({t:'cap'})` del ejecutor vendorizado (05-libro.js), 4096 tokens como `genLibro`;
 *   2. páginas del capítulo que el molde trae escritas por la IA: `sysH()` + `pHTML({t:'vi'|'sc'})`, 8192 como `genPaginas`;
 *   3. juego: `produceScormV2` (motor SCORM v2, 5 salas completas);
 *   4. video: `produceVideo` (Videogen → YouTube → preguntas) con contenedor hvp;
 *   5. presentación: `produceGamma` (es-419, portada rasterizada).
 * Lo pagado se REUSA (`RegenPrior.chapterPieces`): las piezas de texto ya producidas quedan guardadas por capítulo y el
 * render / video / presentación pagados se vuelven a consultar gratis. Un capítulo nunca sale con una pieza de menos:
 * cualquier falla corta la producción con su motivo (RegenError).
 */
import type { DryRunPricing } from '../../pedagogy/dry-run';
import type { WorkshopCourse } from '../course-model';
import { plainText } from '../course-model';
import { mdToHtmlBasic } from '../../../package/dynamic-mbz-builder';
import { addDec } from '../../finops/decimal';
import { ProviderLine, estimateRegen, llmLine } from './estimate';
import { workshopExecutor } from './executor';
import { produceGamma } from './gamma';
import { regenLlmSizes } from './llm-sizes';
import { PaidCallGate, RegenProviders } from './ports';
import { produceScormV2 } from './scorm';
import type { ChapterSource, RegenDbSources } from './sources';
import { hasPendingMarker } from './target';
import { ProducedRegen, RegenError, RegenExternal, RegenPrior, RegenTarget, SCORM_V2_TEMPLATE_IDS, inlineExternal } from './types';
import { produceVideo } from './video';
import { unitExamProblems } from '../patch/op-add-module';
import { VIDEO_PENDING_RE, replaceSlots } from '../patch/op-add-chapter';
import { createExecutorSandbox } from '../../../workers/llm-executor/executor-runtime';
import { syntheticCoverPng, syntheticPdf } from '../../../package/v3/synthetic-media';
import * as vm from 'vm';
import { ChapterPiece, ProducedChapter, ProducedUnitExam } from './chapter-types';
import { stripTrailingFence } from '../xml-scan';

/** Modelo del generador (fijado por Cursia). */
export const CHAPTER_LLM_MODEL = 'claude-sonnet-4-6';
/** max_tokens de las llamadas reales del generador (genLibro / genPaginas / genExamenGift unidad). */
export const LIBRO_MAX_TOKENS = 4096;
export const PAGE_MAX_TOKENS = 8192;
export const UNIT_EXAM_MAX_TOKENS = 4096;
export const UNIT_EXAM_FIX_MAX_TOKENS = 2048;
/** Palabras esperadas de un capítulo del Libro (5 secciones de 250–400 + caso + actividades + glosario). */
export const LIBRO_CHAPTER_WORDS = 2200;
/** Mínimo para aceptar el capítulo del Libro (la mitad de lo pedido): menos es un capítulo cortado. */
export const LIBRO_CHAPTER_MIN_WORDS = 900;

const words = (s: string) => (String(s).match(/[\p{L}\p{N}]+/gu) || []).length;

/** Lo que necesita UN capítulo nuevo (sin red): título, módulo, piezas y si sus páginas son de la IA. */
export interface ChapterSpec {
  chapterNumber: number;
  title: string;
  objective: string | null;
  moduleNumber: number;
  moduleTitle: string;
  pieces: ChapterPiece[];
  pages: { videoPage: boolean; gamePage: boolean };
}

/** Contexto del curso para los prompts del Libro y las páginas (como `ctx()` de 02-run.js, con lo que se sabe). */
export function libroContextOf(course: WorkshopCourse, db: RegenDbSources | null): { text: string; D: Record<string, unknown> } {
  const cc = (db?.courseContext ?? {}) as Record<string, any>;
  const D: Record<string, any> = {
    nombre: course.course.title ?? 'Curso', sector: cc.sector ?? '', pais: cc.pais ?? '', ciudad: cc.ciudad ?? '', contexto: cc.contexto ?? '', nivel: cc.nivel ?? '',
    tono: cc.tono ?? 'cercano y profesional', obj: cc.obj ?? '', comp: cc.comp ?? '', pal: cc.pal ?? {},
    mods: course.modules.map((m) => ({ n: m.title ?? `Módulo ${m.number}`, caps: m.chapterNumbers.map((n) => course.chapters.find((c) => c.number === n)?.title ?? `Capítulo ${n}`) })),
  };
  let s = `Curso: "${D.nombre}" | Sector: ${D.sector} | País: ${D.pais}${D.ciudad ? ` | Ciudad: ${D.ciudad}` : ''}`;
  s += `\nContexto educativo: ${D.contexto}`;
  s += `\nNivel de conocimiento: ${D.nivel} | Tono: ${D.tono}`;
  s += `\nObjetivo: ${D.obj}`;
  s += `\nCompetencia: ${D.comp}`;
  return { text: s, D };
}

function sandboxFor(a: { providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; what: string; D: Record<string, unknown> }) {
  const ex = workshopExecutor({ providers: a.providers, gate: a.gate, pricing: a.pricing, what: a.what, texts: new Map(), ownerId: a.gate.charge.payer });
  ex.sandbox.ctx.D = JSON.parse(JSON.stringify(a.D));
  ex.sandbox.ctx.MEDIA = { videos: {} };
  return ex;
}

/** Prompts reales del generador para el capítulo (también los usa el estimado para medir tamaños). */
export function chapterPrompts(spec: ChapterSpec, course: WorkshopCourse, db: RegenDbSources | null, sizeOnly = false): { libro: { system: string; user: string }; video: { system: string; user: string } | null; game: { system: string; user: string } | null } {
  const { text, D } = libroContextOf(course, db);
  const D2 = { ...D, mods: [...(D.mods as any[])] } as any;
  while (D2.mods.length < spec.moduleNumber) D2.mods.push({ n: spec.moduleTitle, caps: [] });
  D2.mods[spec.moduleNumber - 1] = { ...D2.mods[spec.moduleNumber - 1], n: spec.moduleTitle };
  const ex = workshopExecutor({
    providers: { config: { llmModel: CHAPTER_LLM_MODEL } } as RegenProviders,
    gate: { charge: { payer: 'sizer' } } as PaidCallGate,
    pricing: {} as DryRunPricing, what: 'sizer', texts: new Map(), ownerId: 'sizer',
  });
  void sizeOnly;
  const c = ex.sandbox.ctx;
  c.D = JSON.parse(JSON.stringify(D2));
  // P1-5: pHTML consulta MEDIA.videos: con la pieza de video, el capítulo TIENE video (el hvp nuevo) y la página reserva
  // su espacio (CC_VIDEO_SLOT, que el motor reemplaza por el reproductor); sin video, pediría «VIDEO PENDIENTE».
  c.MEDIA = { videos: spec.pieces.includes('video') ? { [`v${spec.chapterNumber}`]: `hvp-capitulo-${spec.chapterNumber}` } : {} };
  const cap = { n: spec.chapterNumber, t: spec.title };
  const libro = { system: String(c.sysL()), user: String(c.pLibro({ t: 'cap', cn: spec.chapterNumber, cap: spec.title, mi: spec.moduleNumber - 1 }, text)) + (spec.objective ? `\nObjetivo del capítulo: ${spec.objective}` : '') };
  const page = (t: 'vi' | 'sc') => ({ system: String(c.sysH()), user: String(c.pHTML({ t, cap, fn: `cap${cap.n}_${t === 'vi' ? 'video_interactivo' : 'descripcion_actividad'}.html`, n: '', d: '' }, text)) });
  return { libro, video: spec.pages.videoPage ? page('vi') : null, game: spec.pages.gamePage ? page('sc') : null };
}

/** Títulos «Capítulo K:» DENTRO del markdown (además del título inicial del capítulo). */
export function libroExtraChapterHeadings(md: string): string[] {
  const hs = [...String(md ?? '').matchAll(/^\s{0,3}#{1,3}\s*(Cap[ií]tulo\s+\d{1,3}\s*[:—–-][^\n]*)$/gim)].map((m) => m[1].trim());
  const first = /^\s*#{1,3}\s*Cap[ií]tulo\s+\d{1,3}\s*[:—–-]/i.test(String(md ?? '').trimStart());
  return first ? hs.slice(1) : hs;
}

/** Limpieza mínima de una página generada (cercos de código); `<style>`/`<script>` hace fallar (Moodle los borra). */
export function cleanPage(raw: string): string {
  const s = stripTrailingFence(String(raw ?? '').replace(/^\s*```(?:html)?\s*/i, '')).trim();
  if (/<(style|script)\b/i.test(s)) throw new RegenError('invalid_result', 'La página generada trae <style> o <script> (Moodle los elimina): no se usa.');
  if (hasPendingMarker(s)) throw new RegenError('invalid_result', 'La página generada trae «⚠️ Pendiente».');
  if (VIDEO_PENDING_RE.test(replaceSlots(s, () => ''))) throw new RegenError('invalid_result', 'La página generada trae «Video en preparación» fuera del espacio del video: no se usa.');
  if (!plainText(s, 200)) throw new RegenError('invalid_result', 'La página generada viene vacía.');
  return s;
}

type Pieces = NonNullable<RegenPrior['chapterPieces']>[string];

/** Produce UN capítulo. `ext.prior.chapterPieces[N]` guarda lo ya producido (se reusa; nunca se paga dos veces). */
export async function produceChapter(a: { spec: ChapterSpec; course: WorkshopCourse; providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; db: RegenDbSources | null; ext?: RegenExternal }): Promise<ProducedChapter> {
  const { spec } = a;
  const ext = a.ext ?? inlineExternal();
  const prior = ext.prior;
  const key = String(spec.chapterNumber);
  prior.chapterPieces ||= {};
  const rec: Pieces = (prior.chapterPieces[key] ||= {});
  // Lo guardado es una COPIA (el servicio la persiste); el registro de este capítulo sigue siendo `rec`.
  const save = async () => { await ext.onPaid(JSON.parse(JSON.stringify({ ...prior, chapterPieces: { ...prior.chapterPieces, [key]: rec } }))); prior.chapterPieces = { ...(prior.chapterPieces ?? {}), [key]: rec }; };
  const prompts = chapterPrompts(spec, a.course, a.db);
  const { D } = libroContextOf(a.course, a.db);
  // 1. Libro.
  if (!rec.libroMd) {
    const ex = sandboxFor({ ...a, what: 'libro_chapter', D });
    let md: string;
    try {
      md = stripTrailingFence(String(await ex.sandbox.ctx.api(prompts.libro.system, prompts.libro.user, LIBRO_MAX_TOKENS)).replace(/^\s*```markdown\s*/i, ''));
    } catch (e: any) { throw ex.stop ?? new RegenError('internal', String(e?.msg ?? e?.message ?? e)); }
    if (words(md) < LIBRO_CHAPTER_MIN_WORDS) throw new RegenError('invalid_result', `El capítulo del Libro salió con ${words(md)} palabras (mínimo ${LIBRO_CHAPTER_MIN_WORDS}): no se agrega un capítulo cortado.`);
    if (hasPendingMarker(md)) throw new RegenError('invalid_result', 'El capítulo del Libro trae «⚠️ Pendiente».');
    // Ronda 2 (P2-B): lo que la prueba en seco con el sintético NO cubre se valida ANTES de guardar la pieza pagada.
    const extra = libroExtraChapterHeadings(md);
    if (extra.length) throw new RegenError('invalid_result', `El capítulo del Libro trae otros títulos de capítulo adentro (${extra.slice(0, 2).join(' · ')}): rompería la numeración del Libro. No se guarda.`);
    if (!/<h[1-3]>/.test(mdToHtmlBasic(md))) throw new RegenError('invalid_result', 'El capítulo del Libro no tiene títulos de sección.');
    rec.libroMd = md;
    await save();
  }
  // 2. Páginas del capítulo (solo las que el molde trae escritas por la IA).
  for (const [k, pr] of [['videoPageHtml', prompts.video], ['gamePageHtml', prompts.game]] as const) {
    if (!pr || rec[k]) continue;
    const ex = sandboxFor({ ...a, what: 'chapter_page', D });
    let html: string;
    try { html = String(await ex.sandbox.ctx.api(pr.system, pr.user, PAGE_MAX_TOKENS)); } catch (e: any) { throw ex.stop ?? new RegenError('internal', String(e?.msg ?? e?.message ?? e)); }
    // Sin video (o en la página del juego) el bloque del video no tiene qué mostrar: se quita.
    rec[k] = cleanPage(k === 'videoPageHtml' && spec.pieces.includes('video') ? html : replaceSlots(html, () => ''));
    await save();
  }
  // 3. Juego.
  if (!rec.scorm) {
    const target: Extract<RegenTarget, { op: 'regenerate_scorm'; engine: 'scorm_v2' }> = { op: 'regenerate_scorm', engine: 'scorm_v2', moduleId: 0, chapterNumber: spec.chapterNumber, title: spec.title, chapterTitle: spec.title, mechanics: [...SCORM_V2_TEMPLATE_IDS], mechanicsSource: 'default', roomsBefore: null, pendingBefore: false };
    const p = await produceScormV2({ target, course: a.course, providers: a.providers, gate: a.gate, pricing: a.pricing, db: a.db }) as Extract<ProducedRegen, { kind: 'scorm_v2' }>;
    rec.scorm = { html: p.html, manifestXml: p.manifestXml, roomAssignment: p.roomAssignment, rooms: p.rooms };
    await save();
  }
  // Proveedores asíncronos: lo externo de ESTE capítulo vive en las ranuras de arriba mientras se produce (así la espera
  // reanudable de B10 lo encuentra) y se guarda en el capítulo al terminar.
  const chExt = (): RegenExternal => {
    const own: RegenPrior = prior.chapterCurrent === key ? { videogen: prior.videogen ?? null, youtube: prior.youtube ?? null, gamma: prior.gamma ?? null } : { videogen: rec.videogen ?? null, youtube: rec.youtube ?? null, gamma: rec.gamma ?? null };
    return {
      mode: ext.mode, prior: own,
      onPaid: async (p: RegenPrior) => {
        prior.chapterCurrent = key;
        prior.videogen = p.videogen ?? null; prior.youtube = p.youtube ?? null; prior.gamma = p.gamma ?? null;
        rec.videogen = p.videogen ?? null; rec.youtube = p.youtube ?? null; rec.gamma = p.gamma ?? null;
        await save();
      },
    };
  };
  let video: ProducedChapter['video'] = rec.video ?? null;
  if (spec.pieces.includes('video') && !video) {
    const target: Extract<RegenTarget, { op: 'regenerate_video' }> = { op: 'regenerate_video', moduleId: 0, chapterNumber: spec.chapterNumber, title: spec.title, chapterTitle: spec.title, container: 'hvp', delivery: 'youtube', youtubeIdBefore: null, questionsBefore: 0, advanced: false };
    const p = await produceVideo({ target, course: a.course, providers: a.providers, gate: a.gate, pricing: a.pricing, db: a.db, chapterMd: rec.libroMd!, ext: chExt() }) as Extract<ProducedRegen, { kind: 'video' }>;
    video = { hvpJson: p.hvpJson as string, youtubeId: p.youtubeId, durationSec: p.durationSec, interactions: p.interactions, script: p.script, scenes: p.scenes, videogenJobId: p.videogenJobId };
    rec.video = video;
    await save();
  }
  if (!spec.pieces.includes('video')) video = null;
  let presentation: ProducedChapter['presentation'] = null;
  if (spec.pieces.includes('presentation')) {
    const target: Extract<RegenTarget, { op: 'regenerate_gamma' }> = { op: 'regenerate_gamma', moduleId: 0, chapterNumber: spec.chapterNumber, title: spec.title, chapterTitle: spec.title, pdfFile: `cap${spec.chapterNumber}_presentacion.pdf`, coverFile: `cap${spec.chapterNumber}_portada.png`, slidesBefore: null };
    const p = await produceGamma({ target, providers: a.providers, gate: a.gate, pricing: a.pricing, chapterMd: rec.libroMd!, ext: chExt() }) as Extract<ProducedRegen, { kind: 'presentation' }>;
    presentation = { pdf: p.pdf, cover: p.cover, slideCount: p.slideCount, width: p.width, height: p.height, language: p.language, generationId: p.generationId };
  }
  // Capítulo terminado: lo externo queda en el capítulo y las ranuras de arriba se liberan para el siguiente.
  if (prior.chapterCurrent === key) {
    // Lo liquidado por la espera reanudable (B10) quedó en las ranuras de arriba: pasa al capítulo tal cual.
    rec.videogen = prior.videogen ?? rec.videogen ?? null; rec.youtube = prior.youtube ?? rec.youtube ?? null; rec.gamma = prior.gamma ?? rec.gamma ?? null;
    prior.chapterCurrent = null; prior.videogen = null; prior.youtube = null; prior.gamma = null;
    await save();
  }
  return { kind: 'chapter', chapterNumber: spec.chapterNumber, title: spec.title, libroMd: rec.libroMd!, videoPageHtml: rec.videoPageHtml ?? null, gamePageHtml: rec.gamePageHtml ?? null, scorm: rec.scorm!, video, presentation };
}

/** Examen GIFT de la unidad nueva: `sysG()` + `pGIFT({t:'u'})` (+ página `pHTML({t:'ex'})`), como `genExamenGift`. */
export async function produceUnitExam(a: { moduleNumber: number; moduleTitle: string; chapterTitles: string[]; course: WorkshopCourse; providers: RegenProviders; gate: PaidCallGate; pricing: DryRunPricing; db: RegenDbSources | null; ext?: RegenExternal; withInfo: boolean }): Promise<ProducedUnitExam> {
  const ext = a.ext ?? inlineExternal();
  const prior = ext.prior;
  const rec = (prior.unitExam ||= {});
  const p = unitExamPrompts(a);
  const { D } = libroContextOf(a.course, a.db);
  if (!rec.gift) {
    const ex = sandboxFor({ ...a, what: 'unit_exam', D: p.D });
    let gift: string;
    try { gift = String(await ex.sandbox.ctx.api(p.exam.system, p.exam.user, UNIT_EXAM_MAX_TOKENS)).replace(/```gift|```/g, '').trim(); } catch (e: any) { throw ex.stop ?? new RegenError('internal', String(e?.msg ?? e?.message ?? e)); }
    const pr = unitExamProblems(gift);
    if (pr.problems.length) throw new RegenError('invalid_result', `El examen de la unidad nueva no es válido: ${pr.problems.join('; ')}.`);
    rec.gift = `${String(ex.sandbox.ctx.giftFeedbackHeader?.() ?? '')}${gift}`;
    await ext.onPaid({ ...prior });
  }
  if (a.withInfo && !rec.infoHtml) {
    const ex = sandboxFor({ ...a, what: 'chapter_page', D });
    let html: string;
    try { html = String(await ex.sandbox.ctx.api(p.info.system, p.info.user, PAGE_MAX_TOKENS)); } catch (e: any) { throw ex.stop ?? new RegenError('internal', String(e?.msg ?? e?.message ?? e)); }
    rec.infoHtml = cleanPage(html);
    await ext.onPaid({ ...prior });
  }
  return { gift: rec.gift, infoHtml: rec.infoHtml ?? '' };
}

export function unitExamPrompts(a: { moduleNumber: number; moduleTitle: string; chapterTitles: string[]; course: WorkshopCourse; db: RegenDbSources | null }) {
  const { text, D } = libroContextOf(a.course, a.db);
  const D2 = { ...D, mods: [...(D.mods as any[]), { n: a.moduleTitle, caps: a.chapterTitles }] } as any;
  const ex = workshopExecutor({ providers: { config: { llmModel: CHAPTER_LLM_MODEL } } as RegenProviders, gate: { charge: { payer: 'sizer' } } as PaidCallGate, pricing: {} as DryRunPricing, what: 'sizer', texts: new Map(), ownerId: 'sizer' });
  const c = ex.sandbox.ctx;
  c.D = JSON.parse(JSON.stringify(D2));
  c.MEDIA = { videos: {} };
  const m = D2.mods[a.moduleNumber - 1] ?? { n: a.moduleTitle, caps: a.chapterTitles };
  return {
    D: D2,
    exam: { system: String(c.sysG()), user: String(c.pGIFT({ t: 'u', mi: a.moduleNumber - 1, m }, text)) },
    info: { system: String(c.sysH()), user: String(c.pHTML({ t: 'ex', mi: a.moduleNumber - 1, m, fn: `examen_unidad${a.moduleNumber}_descripcion.html`, n: '', d: '' }, text)) },
  };
}

// ─── Estimado por pieza y proveedor (D8) ────────────────────────────────────

export interface ChapterPieceCost { piece: string; providers: ProviderLine[]; expectedUsd: string; boundUsd: string }
export interface ChapterEstimate { pieces: ChapterPieceCost[]; providers: ProviderLine[]; expectedUsd: string; totalBoundUsd: string; calls: number; min: string; max: string; basis: string }

const sumUsd = (...xs: string[]) => addDec('0', ...xs);

/** Junta líneas por proveedor. */
export function mergeLines(lines: ProviderLine[]): ProviderLine[] {
  const by = new Map<string, ProviderLine>();
  for (const l of lines) {
    const k = l.provider;
    const cur = by.get(k);
    if (!cur) by.set(k, { ...l });
    else by.set(k, { provider: l.provider, calls: cur.calls + l.calls, expectedUsd: sumUsd(cur.expectedUsd, l.expectedUsd), boundUsd: sumUsd(cur.boundUsd, l.boundUsd), what: `${cur.what}; ${l.what}`, note: cur.note ?? l.note ?? null });
  }
  return [...by.values()];
}

/** Estimado de UN capítulo: cada pieza con los MISMOS prompts y max_tokens del generador (sin gastar). */
export function estimateChapter(spec: ChapterSpec, course: WorkshopCourse, pricing: DryRunPricing, db: RegenDbSources | null): ChapterEstimate {
  const prompts = chapterPrompts(spec, course, db, true);
  const pieces: ChapterPieceCost[] = [];
  const llm = (piece: string, what: string, sizes: Array<{ promptChars: number; maxTokens: number }>) => {
    const l = llmLine(pricing, CHAPTER_LLM_MODEL, sizes.map((z) => ({ what, promptChars: z.promptChars, maxTokens: z.maxTokens, retryPromptChars: null, retryMaxTokens: null })));
    const line: ProviderLine = { provider: 'anthropic', calls: l.calls, expectedUsd: l.expectedUsd, boundUsd: l.boundUsd, what };
    pieces.push({ piece, providers: [line], expectedUsd: l.expectedUsd, boundUsd: l.boundUsd });
  };
  llm('libro', `capítulo ${spec.chapterNumber} del Libro Guía (1 llamada, ${LIBRO_MAX_TOKENS} tokens)`, [{ promptChars: prompts.libro.system.length + prompts.libro.user.length, maxTokens: LIBRO_MAX_TOKENS }]);
  if (prompts.video) llm('video_page', 'página del capítulo (video)', [{ promptChars: prompts.video.system.length + prompts.video.user.length, maxTokens: PAGE_MAX_TOKENS }]);
  if (prompts.game) llm('game_page', 'descripción del juego', [{ promptChars: prompts.game.system.length + prompts.game.user.length, maxTokens: PAGE_MAX_TOKENS }]);
  // Fuente supuesta para el resto: el capítulo del Libro que todavía no existe (tamaño típico del generador).
  const src: ChapterSource[] = [{ number: spec.chapterNumber, title: spec.title, md: 'x '.repeat(LIBRO_CHAPTER_WORDS), words: LIBRO_CHAPTER_WORDS, origin: 'db' }];
  const regen = (piece: string, t: RegenTarget) => {
    const e = estimateRegen(t, { pricing, llmModel: CHAPTER_LLM_MODEL, ttsModel: 'gpt-4o-mini-tts-2025-03-20', sources: src, llmSizes: regenLlmSizes(t, { course, db, sources: src }) });
    pieces.push({ piece, providers: e.regen.providers, expectedUsd: e.expectedUsd, boundUsd: e.regen.totalBoundUsd });
  };
  regen('game', { op: 'regenerate_scorm', engine: 'scorm_v2', moduleId: 0, chapterNumber: spec.chapterNumber, title: spec.title, chapterTitle: spec.title, mechanics: [...SCORM_V2_TEMPLATE_IDS], mechanicsSource: 'default', roomsBefore: null, pendingBefore: false });
  if (spec.pieces.includes('video')) regen('video', { op: 'regenerate_video', moduleId: 0, chapterNumber: spec.chapterNumber, title: spec.title, chapterTitle: spec.title, container: 'hvp', delivery: 'youtube', youtubeIdBefore: null, questionsBefore: 0, advanced: false });
  if (spec.pieces.includes('presentation')) regen('presentation', { op: 'regenerate_gamma', moduleId: 0, chapterNumber: spec.chapterNumber, title: spec.title, chapterTitle: spec.title, pdfFile: '', coverFile: '', slidesBefore: null });
  return totals(pieces);
}

export function estimateUnitExam(a: { moduleNumber: number; moduleTitle: string; chapterTitles: string[]; course: WorkshopCourse; db: RegenDbSources | null; withInfo: boolean }, pricing: DryRunPricing): ChapterPieceCost[] {
  const p = unitExamPrompts(a);
  const out: ChapterPieceCost[] = [];
  const add = (piece: string, what: string, promptChars: number, maxTokens: number) => {
    const l = llmLine(pricing, CHAPTER_LLM_MODEL, [{ what, promptChars, maxTokens, retryPromptChars: null, retryMaxTokens: null }]);
    out.push({ piece, providers: [{ provider: 'anthropic', calls: l.calls, expectedUsd: l.expectedUsd, boundUsd: l.boundUsd, what }], expectedUsd: l.expectedUsd, boundUsd: l.boundUsd });
  };
  add('exam', `examen GIFT de la unidad ${a.moduleNumber}`, p.exam.system.length + p.exam.user.length, UNIT_EXAM_MAX_TOKENS);
  if (a.withInfo) add('exam_page', 'página del examen', p.info.system.length + p.info.user.length, PAGE_MAX_TOKENS);
  return out;
}

export function totals(pieces: ChapterPieceCost[]): ChapterEstimate {
  const providers = mergeLines(pieces.flatMap((p) => p.providers));
  const expected = sumUsd(...pieces.map((p) => p.expectedUsd));
  const bound = sumUsd(...pieces.map((p) => p.boundUsd));
  return { pieces, providers, expectedUsd: expected, totalBoundUsd: bound, calls: providers.reduce((n, l) => n + l.calls, 0), min: (Number(expected) * 0.7).toFixed(6), max: bound, basis: 'prompts y max_tokens reales del generador; precios del catálogo de FinOps' };
}

// ─── P1-1: producido SINTÉTICO de forma válida (sin red, sin IA) para la prueba en seco ANTES de gastar ──────────────

let synthCtx: Record<string, any> | null = null;
function synthSandbox(): Record<string, any> {
  if (!synthCtx) synthCtx = createExecutorSandbox({ api: async () => { throw { fatal: true, msg: 'prueba en seco: sin IA' }; }, artifactText: async () => null, ownerId: 'dry-run', logger: { log: () => undefined, warn: () => undefined, error: () => undefined } }).ctx;
  return synthCtx;
}
const SYNTH_PARA = 'Este párrafo de la prueba en seco ocupa el lugar del texto que escribirá el generador del Libro para el capítulo nuevo, con ejemplos concretos y pasos ordenados.';

/** Capítulo con la FORMA de lo que se producirá (valida en el motor), para saber si el paquete lo admite sin pagar. */
export function syntheticChapter(spec: ChapterSpec): ProducedChapter {
  const c = synthSandbox();
  const cap = { n: spec.chapterNumber, t: spec.title };
  const ids = [...SCORM_V2_TEMPLATE_IDS].slice(0, 5);
  const fixtures = JSON.parse(vm.runInContext('JSON.stringify(SV2_PREVIEW_FIXTURES)', c as vm.Context));
  const rooms = ids.map((id) => ({ templateId: id, data: fixtures[id] }));
  const page = (t: string, slot: boolean) => `<div style="background:#0A1628;border-radius:20px;padding:32px;color:#E2E6F3;font-family:'Segoe UI',Arial,sans-serif;"><h2 style="color:#E2E6F3;">${t}</h2><p style="color:#E2E6F3;">${SYNTH_PARA}</p>${slot ? '<!-- CC_VIDEO_SLOT_START --><div>espacio del video</div><!-- CC_VIDEO_SLOT_END -->' : ''}</div>`;
  const yt = 'WsDryRun001';
  const video = spec.pieces.includes('video') ? { hvpJson: JSON.stringify({ interactiveVideo: { video: { files: [{ path: `https://www.youtube.com/watch?v=${yt}`, mime: 'video/YouTube' }], startScreenOptions: {} }, assets: { interactions: [{ action: { library: 'H5P.MultiChoice 1.16', params: { question: '<p>¿Qué muestra el video?</p>', answers: [{ text: 'El caso del capítulo', correct: true }, { text: 'Otro tema', correct: false }], behaviour: { type: 'auto' } } }, duration: { from: 30, to: 40 } }] } } }), youtubeId: yt, durationSec: 300, interactions: 1, script: 'Prueba en seco.', scenes: 1, videogenJobId: 'dry-run' } : null;
  return {
    kind: 'chapter', chapterNumber: spec.chapterNumber, title: spec.title,
    libroMd: [`# Capítulo ${spec.chapterNumber}: ${spec.title}`, ...[1, 2, 3, 4, 5].map((k) => `## ${spec.chapterNumber}.${k} Sección ${k}\n\n${Array.from({ length: 9 }, () => SYNTH_PARA).join(' ')}`)].join('\n\n'),
    videoPageHtml: spec.pages.videoPage ? page(`Video del capítulo ${spec.chapterNumber}`, spec.pieces.includes('video')) : null,
    gamePageHtml: spec.pages.gamePage ? page(`Juego del capítulo ${spec.chapterNumber}`, false) : null,
    scorm: { html: String(c.buildScormV2Html(cap, ids, rooms)), manifestXml: String(c.defMf(cap)), roomAssignment: ids, rooms: 5 },
    video,
    presentation: spec.pieces.includes('presentation') ? { pdf: syntheticPdf(10), cover: syntheticCoverPng(1600, 900, '#0F766E'), slideCount: 10, width: 1600, height: 900, language: 'es-419', generationId: 'dry-run' } : null,
  };
}

/** Examen GIFT sintético de la unidad nueva (forma válida para el motor). */
export function syntheticUnitExam(withInfo: boolean): ProducedUnitExam {
  const qs = Array.from({ length: 6 }, (_, i) => `::U-${i + 1}::¿Qué conviene revisar en el caso ${i + 1}? {\n  =Los datos del caso\n  ~La opinión de otro\n  ~El resultado de otro año\n  ~Un dato sin fuente\n}`);
  return { gift: qs.join('\n\n'), infoHtml: withInfo ? `<div style="background:#0A1628;border-radius:20px;padding:32px;color:#E2E6F3;"><p style="color:#E2E6F3;">${SYNTH_PARA}</p></div>` : '' };
}

// ─── Ronda 2 (P2-B): pieza descartable si el motor rechaza el contenido REAL ─────────────────────────────────────────

/** Piezas de texto de un capítulo producido (lo externo pagado —render, video publicado, Gamma— se conserva). */
export const TEXT_PIECES = Object.freeze(['libroMd', 'videoPageHtml', 'gamePageHtml', 'scorm', 'video'] as const);
export type TextPiece = (typeof TEXT_PIECES)[number];
/** Pieza del estimado (`estimateChapter`) que rehace cada pieza guardada. */
export const PIECE_OF: Record<TextPiece, string> = { libroMd: 'libro', videoPageHtml: 'video_page', gamePageHtml: 'game_page', scorm: 'game', video: 'video' };

/**
 * Cuál pieza culpar por el rechazo del motor (`new_findings` / `invariant`): la que nombra el mensaje; si no se puede
 * saber, TODAS las de texto del ítem.
 */
export function culpritPieces(message: string): TextPiece[] {
  const m = String(message ?? '');
  if (/Libro/i.test(m) && !/juego|SCORM|video|página|enlace|bot[oó]n/i.test(m)) return ['libroMd'];
  if (/SCORM|juego|sala/i.test(m) && !/Libro|video|página|enlace/i.test(m)) return ['scorm'];
  if (/(enlace|bot[oó]n|página|dead_link|href)/i.test(m) && !/Libro|SCORM|juego/i.test(m)) return ['videoPageHtml', 'gamePageHtml'];
  return [...TEXT_PIECES];
}

/**
 * Ronda 3 (P2-F): invariantes del motor que dependen del CONTENIDO generado (el Libro producido no queda en orden, no
 * nombra el capítulo o no cierra). Cualquier otro `invariant` (el paquete no abre, conteos, ids…) no lo arregla
 * rehacer el contenido: no se descarta nada y el reintento no se ofrece.
 */
export const CONTENT_INVARIANTS: readonly RegExp[] = Object.freeze([
  /El Libro resultante no quedó con sus capítulos en orden/i,
  /El Libro resultante no nombra/i,
  /El Libro recompuesto no cierra/i,
]);

/** Qué hacer ante un rechazo del motor del contenido producido. */
export function discardPolicy(code: string | null | undefined, message: string): { pieces: TextPiece[]; contentFailure: boolean } {
  if (code === 'new_findings') return { pieces: culpritPieces(message), contentFailure: true };
  if (code === 'invariant' && CONTENT_INVARIANTS.some((re) => re.test(message))) return { pieces: culpritPieces(message), contentFailure: true };
  return { pieces: [], contentFailure: false };
}

/**
 * Ronda 3 (P2-G): costo de rehacer lo descartado, con las cotas del estimado. Del video solo se paga de nuevo la IA (el
 * render y el video publicado se reusan). Con `alsoExam` (módulo, todo descartado) suma el examen y su página.
 */
export function retryCostOf(est: { pieces: Array<{ piece: string; expectedUsd: string; boundUsd: string; providers: Array<{ provider: string; expectedUsd: string; boundUsd: string }> }> }, pieces: readonly TextPiece[], alsoExam: boolean): { pieces: string[]; expectedUsd: number; boundUsd: number } {
  const want = new Set<string>(pieces.map((p) => PIECE_OF[p]));
  if (alsoExam) { want.add('exam'); want.add('exam_page'); }
  const redo = est.pieces.filter((p) => want.has(p.piece.replace(/^cap\d+:/, '')));
  const part = (p: (typeof redo)[number], k: 'expectedUsd' | 'boundUsd') => (p.piece.replace(/^cap\d+:/, '') === 'video' ? p.providers.filter((l) => l.provider === 'anthropic').reduce((x, l) => x + Number(l[k]), 0) : Number(p[k]));
  return { pieces: [...want], expectedUsd: redo.reduce((a, p) => a + part(p, 'expectedUsd'), 0), boundUsd: redo.reduce((a, p) => a + part(p, 'boundUsd'), 0) };
}

/** Quita esas piezas de lo pagado guardado (el reintento las rehace en vez de reusarlas). */
export function discardPieces(prior: RegenPrior, chapterNumbers: number[], pieces: readonly TextPiece[], alsoExam: boolean): RegenPrior {
  const out: RegenPrior = JSON.parse(JSON.stringify(prior ?? {}));
  for (const n of chapterNumbers) {
    const rec = out.chapterPieces?.[String(n)] as Record<string, unknown> | undefined;
    if (rec) for (const p of pieces) delete rec[p];
  }
  if (alsoExam && out.unitExam) out.unitExam = {};
  return out;
}
