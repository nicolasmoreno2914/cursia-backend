/**
 * r107 B11 · motor de parches — Fase 4: `add_chapter` (y la parte de capítulos de `add_module`).
 *
 * Inserta UN capítulo nuevo con el patrón completo del builder V1 que armó el curso (`mbz-builder.service.ts` /
 * `09-mbz.js`): [label Gamma] → [label texto] → [hvp] → [label CTA «🎯 Practicar — Cap N»] → [scorm], o la variante que
 * tenga ESTE paquete (V1 sin hvp: [▶️ página del capítulo] → [scorm]). El molde es un capítulo hermano del mismo paquete:
 *   - la ESTRUCTURA Moodle de cada actividad (module.xml, grades.xml, roles.xml, inforef…) se clona del molde con ids
 *     NUEVOS (máximo de todo el paquete; `sco` / `sco_data` en su rango 60000+), sección y número de sección del destino;
 *   - las piezas que el builder arma con PLANTILLA fija (tarjeta de la presentación, introducción del video «📺 Cómo
 *     aprovechar este video», CTA «¿Listo para poner a prueba lo aprendido?») se reescriben con el número, el título y
 *     los tokens del capítulo nuevo, exactamente donde el builder los pone;
 *   - el contenido escrito por la IA (página del capítulo, descripción del juego, juego, video, presentación, Libro) es
 *     el PRODUCIDO, revalidado acá (salas completas, sin «⚠️ Pendiente», preguntas con una sola correcta, PDF legible);
 *   - cada blob nuevo con su SHA1 en files.xml + `files/<hh>/<sha1>`; `<activities>` + `<settings>` de moodle_backup.xml
 *     y `<sequence>` de section.xml coherentes;
 *   - numeración: los capítulos posteriores suben uno SOLO donde el builder pone el número (nombres de actividades,
 *     títulos de los SCO y del libro de calificaciones, insignias «Capítulo N» / «CAPÍTULO N» de sus plantillas, resumen
 *     «Capítulos 1, 2 y 3 con…» de la sección del módulo, títulos y TOC del Libro Guía). Lo demás queda byte a byte;
 *   - Libro Guía HTML: la sección del capítulo (markdown → HTML con el conversor del backend) y su entrada del índice;
 *     cierra en `</html>`. Sin Libro HTML → no disponible (nunca un Libro sin el capítulo).
 * Todo o nada: cualquier pieza que falte o no valide hace fallar la operación (y el plan entero).
 */
import { mdToHtmlBasic } from '../../../package/dynamic-mbz-builder';
import { safeActivityName } from '../../../package/mbz-common';
import { parseScormManifestIds } from '../../../package/v3/moodle-activities-v3';
import { xmlUnescape } from '../../visual-design/preview-extract';
import JSZip = require('jszip');
import { WorkshopActivity, WorkshopCourse, plainText } from '../course-model';
import { libroChapterSequence } from '../diagnosis/checks';
import { scormProblems } from '../regenerate/scorm';
import { hasPendingMarker } from '../regenerate/target';
import { ADD_CHAPTER_FAMILIES, AddChapterOp, ChapterPiece, ProducedChapter, V3_ADD_CHAPTER_UNAVAILABLE } from '../regenerate/chapter-types';
import { sha1Of } from './container';
import { xmlEsc } from './html-edit';
import { IdAllocator } from './ids';
import { OpContext, blobPath, noteModified } from './op-context';
import { libroStructure, recomposeLibro } from './op-libro';
import { producedProblems } from './op-regenerate';
import { PatchError } from './types';

const htmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Reemplazo literal (sin patrones especiales de `String.replace`: nunca `$&`). */
const replaceLit = (s: string, from: string, to: string): { out: string; n: number } => {
  if (!from) return { out: s, n: 0 };
  const parts = s.split(from);
  return { out: parts.join(to), n: parts.length - 1 };
};

/** Firmas de las piezas que el builder V1 arma con PLANTILLA (no con la IA). */
/** Bloque del video que pide `pHTML` (tipo `vi`): lo reemplaza el empaquetado (16-mbz-patch.js `makeH5PEmbed`). */
export const SLOT_RE = /<!--\s*CC_VIDEO_SLOT_START\s*-->[\s\S]*?<!--\s*CC_VIDEO_SLOT_END\s*-->/g;
/**
 * Texto del marcador «video pendiente» que nunca puede quedar en un capítulo entregado. Ronda 2 (P2-C): solo «Video en
 * preparación» y el bloque CC_VIDEO_SLOT; «disponible próximamente» es una frase legítima del contenido.
 */
export const VIDEO_PENDING_RE = /Video en preparaci[oó]n|CC_VIDEO_SLOT/i;
/** El reproductor embebido del hvp (el de `makeH5PEmbed`, sin el <script> del resizer: el Taller no agrega scripts). */
export const hvpEmbedHtml = (mid: number): string => '<div style="position:relative;width:100%;max-width:840px;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:14px;margin:16px auto 20px;background:#08111C;border:1px solid rgba(96,165,250,0.15);box-shadow:0 8px 32px rgba(0,0,0,0.5);">'
  + `<iframe src="$@HVPEMBEDBYID*${mid}@$" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen="allowfullscreen" title="Video Interactivo"></iframe></div>`;

export const V1_TEMPLATE_SIGNATURES = Object.freeze({
  presentation: 'Presentación del capítulo',
  videoIntro: '📺 Cómo aprovechar este video',
  cta: '¿Listo para poner a prueba lo aprendido?',
  scormDefaultIntro: '<p>Actividad interactiva SCORM</p>',
});

// ─── Numeración ─────────────────────────────────────────────────────────────

/** Número de capítulo en un NOMBRE del builder («Cap. N —», «Cap N», «Capítulo N»): n → n2. */
export function renumberName(s: string, n: number, n2: number): string {
  return s.replace(new RegExp(`(\\bCap\\.?\\s+|\\bCap[ií]tulo\\s+)${n}(?!\\d)`, 'g'), (_m, p: string) => `${p}${n2}`);
}

/** Insignias de las plantillas del builder dentro del HTML crudo (escapado en el XML): «>Capítulo N<» y «· CAPÍTULO N<». */
function renumberTemplateBadgesRaw(raw: string, n: number, n2: number): { out: string; n: number } {
  let count = 0;
  const out = raw
    .replace(new RegExp(`(&gt;Cap[ií]tulo )${n}(&lt;/span&gt;)`, 'g'), (_m, a: string, b: string) => { count++; return `${a}${n2}${b}`; })
    .replace(new RegExp(`(· CAP[IÍ]TULO )${n}(&lt;)`, 'g'), (_m, a: string, b: string) => { count++; return `${a}${n2}${b}`; });
  return { out, n: count };
}

/** Lista «1, 2 y 3» → números; null si no es una lista del builder. */
export function parseChapterList(s: string): number[] | null {
  if (!/^\d+(?:, \d+)*(?: y \d+)?$/.test(s)) return null;
  return s.split(/, | y /).map(Number);
}
export function formatChapterList(xs: number[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}

// ─── Lectura / escritura por entrada ────────────────────────────────────────

class Texts {
  private readonly m = new Map<string, { orig: string; cur: string }>();
  constructor(private readonly ctx: OpContext) {}
  async get(e: string): Promise<string> {
    let v = this.m.get(e);
    if (!v) { const t = await this.ctx.state.readText(e); v = { orig: t, cur: t }; this.m.set(e, v); }
    return v.cur;
  }
  async set(e: string, t: string): Promise<void> { await this.get(e); this.m.get(e)!.cur = t; }
  flush(): void {
    for (const [e, v] of this.m) if (v.cur !== v.orig) { this.ctx.state.write(e, v.cur); noteModified(this.ctx, e); }
  }
}

/** Edita el contenido de la PRIMERA (o todas) `<tag>…</tag>` con `fn`. */
function editTag(xml: string, tag: string, fn: (inner: string) => string, all = false): string {
  const re = new RegExp(`(<${tag}>)([\\s\\S]*?)(</${tag}>)`, all ? 'g' : '');
  return xml.replace(re, (_m, a: string, inner: string, c: string) => `${a}${fn(inner)}${c}`);
}

// ─── Contexto del capítulo nuevo ────────────────────────────────────────────

export interface ChapterPlacement {
  /** Sección (id y número) del módulo donde va. */
  sectionId: number;
  sectionNumber: number;
  /** Posición en el `<sequence>` de esa sección donde empieza el capítulo nuevo. */
  sequenceIndex: number;
  /** Módulo del capítulo (número y título) y el del molde. */
  moduleNumber: number;
  moduleTitle: string | null;
}

interface TemplateChapter {
  number: number;
  title: string;
  moduleNumber: number | null;
  moduleTitle: string | null;
  activities: WorkshopActivity[];
}

/** Molde: el capítulo pedido, con todas sus actividades en UNA sección, en orden, con rol conocido. */
export function templateOf(inv: WorkshopCourse, n: number, expectIds?: number[]): TemplateChapter {
  // P1-3: con la precondición, el molde se busca por SUS actividades (otra operación del plan pudo renumerarlo).
  const byIds = expectIds && expectIds.length ? inv.chapters.find((c) => [...c.activities].sort((a, b) => a - b).join(',') === [...expectIds].sort((a, b) => a - b).join(',')) : null;
  if (expectIds && expectIds.length && !byIds) throw new PatchError('stale_target', `El capítulo molde (actividades ${expectIds.join(', ')}) cambió desde que se armó el plan.`);
  const ch = byIds ?? inv.chapters.find((c) => c.number === n);
  if (!ch) throw new PatchError('target_not_found', `El capítulo molde ${n} no está en el paquete.`);
  n = ch.number;
  if (!ch.title) throw new PatchError('unsupported', `El capítulo molde ${n} no tiene título reconocible: no se usa de molde.`);
  const acts = ch.activities.map((id) => inv.activities.find((a) => a.moduleId === id)).filter((a): a is WorkshopActivity => !!a);
  if (acts.length !== ch.activities.length || acts.some((a) => a.missingFolder)) throw new PatchError('unsupported', `El capítulo molde ${n} tiene actividades sin carpeta.`);
  const secs = [...new Set(acts.map((a) => a.sectionId))];
  if (secs.length !== 1 || secs[0] === null) throw new PatchError('unsupported', `El capítulo molde ${n} no está en una sola sección.`);
  if (acts.some((a) => !a.role || a.role === 'unknown' || a.role === 'audio' || a.role === 'activity')) throw new PatchError('unsupported', `El capítulo molde ${n} tiene actividades que el Taller no sabe rehacer (${acts.filter((a) => !a.role || ['unknown', 'audio', 'activity'].includes(a.role)).map((a) => a.title).join(', ')}).`);
  if (acts.some((a) => a.pending)) throw new PatchError('unsupported', `El capítulo molde ${n} tiene un «⚠️ Pendiente»: no se usa de molde.`);
  const sorted = [...acts].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (!sorted.some((a) => a.role === 'game')) throw new PatchError('unsupported', `El capítulo molde ${n} no tiene juego.`);
  if (expectIds && JSON.stringify(sorted.map((a) => a.moduleId)) !== JSON.stringify(expectIds)) throw new PatchError('stale_target', `El capítulo molde ${n} cambió desde que se armó el plan.`);
  const mod = inv.modules.find((m) => m.number === ch.moduleNumber) ?? null;
  return { number: n, title: ch.title, moduleNumber: ch.moduleNumber, moduleTitle: mod?.title ?? null, activities: sorted };
}

/** Piezas que lleva el capítulo nuevo (las del molde menos las omitidas), en orden. */
export function chapterPieces(t: TemplateChapter, omit: readonly string[] = []): Array<{ piece: ChapterPiece; activity: WorkshopActivity }> {
  return t.activities.map((a) => ({ piece: a.role as ChapterPiece, activity: a })).filter((x) => !(omit as string[]).includes(x.piece));
}

/** Dónde va el capítulo nuevo en el módulo (V1: sección del módulo con varios capítulos). */
export function placementOf(inv: WorkshopCourse, moduleNumber: number, position: number): ChapterPlacement {
  const mod = inv.modules.find((m) => m.number === moduleNumber);
  if (!mod) throw new PatchError('target_not_found', `El curso no tiene el módulo ${moduleNumber}.`);
  if (mod.sectionNumbers.length !== 1) throw new PatchError('unsupported', `El módulo ${moduleNumber} no está en una sola sección.`);
  const sec = inv.sections.find((s) => s.number === mod.sectionNumbers[0]);
  if (!sec) throw new PatchError('target_not_found', `Falta la sección del módulo ${moduleNumber}.`);
  const nums = [...mod.chapterNumbers].sort((a, b) => a - b);
  const prevMax = Math.max(0, ...inv.chapters.filter((c) => c.moduleNumber !== null && c.moduleNumber < moduleNumber).map((c) => c.number));
  const lo = nums.length ? nums[0] : prevMax + 1;
  const hi = nums.length ? nums[nums.length - 1] + 1 : prevMax + 1;
  if (!Number.isInteger(position) || position < lo || position > hi) throw new PatchError('invalid_params', `En el módulo ${moduleNumber} el capítulo nuevo puede ser del ${lo} al ${hi} (pediste ${position}).`);
  const seq = sec.sequence;
  let idx: number;
  const at = inv.chapters.find((c) => c.number === position && c.moduleNumber === moduleNumber);
  const before = inv.chapters.find((c) => c.number === position - 1 && c.moduleNumber === moduleNumber);
  if (at) idx = Math.min(...at.activities.map((m) => seq.indexOf(m)).filter((i) => i >= 0));
  else if (before) idx = Math.max(...before.activities.map((m) => seq.indexOf(m)).filter((i) => i >= 0)) + 1;
  else idx = 0;
  if (!Number.isFinite(idx) || idx < 0) throw new PatchError('unsupported', 'No se pudo ubicar el capítulo en la secuencia de la sección.');
  return { sectionId: sec.id, sectionNumber: sec.number ?? 0, sequenceIndex: idx, moduleNumber, moduleTitle: mod.title };
}

// ─── Validación del producido ──────────────────────────────────────────────

export async function producedChapterProblems(p: ProducedChapter, need: { video: boolean; presentation: boolean; videoPage: boolean; gamePage: boolean }): Promise<string[]> {
  const out: string[] = [];
  if (!p || p.kind !== 'chapter') return ['no es un capítulo producido'];
  if (!plainText(p.title ?? '', 20)) out.push('el capítulo no tiene título');
  if (!p.libroMd || plainText(mdToHtmlBasic(p.libroMd), 400).length < 200) out.push('el capítulo del Libro está vacío o es demasiado corto');
  for (const [k, v] of [['libro', p.libroMd], ['página del video', p.videoPageHtml], ['página del juego', p.gamePageHtml]] as const) {
    if (v && hasPendingMarker(v)) out.push(`la ${k} trae un marcador «⚠️ Pendiente»`);
    if (v && k !== 'libro' && /<script\b/i.test(v)) out.push(`la ${k} trae <script>`);
    // P1-5: el bloque del video se resuelve al insertar; fuera de él no puede quedar «Video en preparación».
    if (v && k !== 'libro' && VIDEO_PENDING_RE.test(v.replace(SLOT_RE, ''))) out.push(`la ${k} trae «Video en preparación» (o el bloque del video sin cerrar)`);
    if (v && k === 'página del juego' && /CC_VIDEO_SLOT_START/.test(v)) out.push('la página del juego trae un bloque de video');
  }
  if (need.videoPage && !plainText(p.videoPageHtml ?? '', 40)) out.push('falta la página del video del capítulo');
  if (need.gamePage && !plainText(p.gamePageHtml ?? '', 40)) out.push('falta la descripción del juego del capítulo');
  if (!p.scorm) out.push('falta el juego del capítulo');
  else out.push(...scormProblems(p.scorm).map((x) => `juego: ${x}`));
  if (need.video) {
    if (!p.video) out.push('falta el video del capítulo');
    else out.push(...(await producedProblems({ kind: 'video', moduleId: 0, chapterNumber: p.chapterNumber, container: 'hvp', youtubeId: p.video.youtubeId, durationSec: p.video.durationSec, interactions: p.video.interactions, h5p: null, hvpJson: p.video.hvpJson, script: p.video.script, scenes: p.video.scenes, videogenJobId: p.video.videogenJobId })).map((x) => `video: ${x}`));
  }
  if (need.presentation) {
    if (!p.presentation) out.push('falta la presentación del capítulo');
    else out.push(...(await producedProblems({ kind: 'presentation', moduleId: 0, chapterNumber: p.chapterNumber, ...p.presentation })).map((x) => `presentación: ${x}`));
  }
  return out;
}

/** ¿El molde trae la pieza armada por la IA (y no la plantilla)? Decide qué páginas hay que producir. */
export async function pagesNeeded(ctx: { readText(e: string): Promise<string> }, pieces: Array<{ piece: ChapterPiece; activity: WorkshopActivity }>, omit: readonly string[] = []): Promise<{ videoPage: boolean; gamePage: boolean }> {
  // Sin video, el builder pone la PÁGINA del capítulo (escrita por la IA) en lugar de la introducción del video.
  let videoPage = omit.includes('video') && pieces.some((x) => x.piece === 'text');
  let gamePage = false;
  for (const { piece, activity: a } of pieces) {
    const intro = a.html.find((h) => h.field === 'intro')?.html ?? '';
    if ((piece === 'text' || piece === 'video') && !intro.includes(V1_TEMPLATE_SIGNATURES.videoIntro)) videoPage = true;
    if (piece === 'cta' && !intro.includes(V1_TEMPLATE_SIGNATURES.cta)) gamePage = true;
    if (piece === 'game' && intro.trim() !== V1_TEMPLATE_SIGNATURES.scormDefaultIntro && intro.trim() !== '') gamePage = true;
  }
  void ctx;
  return { videoPage, gamePage };
}

// ─── Operación ─────────────────────────────────────────────────────────────

export interface InsertedChapter { number: number; moduleIds: number[]; scormModuleId: number }

export async function applyAddChapter(ctx: OpContext, op: AddChapterOp): Promise<void> {
  if (!(ADD_CHAPTER_FAMILIES as readonly string[]).includes(ctx.family)) {
    throw new PatchError('unavailable', ctx.family === 'v2-dynamic' ? V3_ADD_CHAPTER_UNAVAILABLE : `Agregar capítulos no está disponible para cursos de la familia «${ctx.family}» (no hay un capítulo armado por el builder que sirva de molde).`);
  }
  const p = op.produced;
  if (!p) throw new PatchError('invalid_params', 'Falta el capítulo producido (la producción no corrió o no se cargó su resultado): no se aplica nada.');
  if (p.chapterNumber !== op.position) throw new PatchError('invalid_params', 'El capítulo producido es para otra posición.');
  const t = templateOf(ctx.inv, op.templateChapter, op.expect?.templateModuleIds);
  const pl = placementOf(ctx.inv, op.moduleNumber, op.position);
  const pieces = chapterPieces(t, op.omit ?? []);
  const need = await pagesNeeded(ctx.state, pieces, op.omit ?? []);
  const problems = await producedChapterProblems(p, { video: pieces.some((x) => x.piece === 'video'), presentation: pieces.some((x) => x.piece === 'presentation'), ...need });
  if (problems.length) throw new PatchError('invalid_content', `El capítulo nuevo no es válido y no se aplica: ${problems.join('; ')}.`);
  const texts = new Texts(ctx);
  const ins = await insertChapter(ctx, texts, { t, pl, pieces, p, title: op.title, noVideo: (op.omit ?? []).includes('video') });
  await insertLibroChapter(ctx, texts, { position: op.position, title: op.title, md: p.libroMd, moduleOf: (n) => ctx.inv.chapters.find((c) => c.number === n)?.moduleNumber ?? null, moduleNumber: op.moduleNumber });
  texts.flush();
  const r = ctx.report;
  r.summary = `Capítulo ${op.position} nuevo «${op.title}» en el módulo ${op.moduleNumber} (${pieces.length} actividad(es): ${pieces.map((x) => x.piece).join(' → ')})`;
  r.notes.push(`molde: capítulo ${t.number} «${t.title}»`, `actividades nuevas: ${ins.moduleIds.join(', ')}`);
  if (op.omit?.length) r.notes.push(`sin ${op.omit.map((x) => (x === 'video' ? 'video' : 'presentación de Gamma')).join(' ni ')} (pedido del docente)`);
  chapterMisalignment(ctx, op.position);
}

/** D7: lo que el capítulo nuevo deja desalineado y NO se arregla solo. */
export function chapterMisalignment(ctx: OpContext, position: number): void {
  const r = ctx.report;
  if (ctx.inv.audiobook.length) r.misalignment.push(`El audiolibro del curso no incluye el capítulo ${position} nuevo: rehacerlo es un pedido aparte (regenerate_audio) con su costo.`);
  const exams = ctx.inv.activities.filter((a) => a.exam && !a.missingFolder);
  if (exams.some((a) => a.exam!.final)) r.misalignment.push(`El examen final no tiene preguntas del capítulo ${position} nuevo: agregarlas es un pedido aparte (exam_question_add) con su costo.`);
  const later = ctx.inv.chapters.filter((c) => c.number >= position).map((c) => c.number);
  if (later.length) r.misalignment.push(`Los capítulos ${formatChapterList(later)} pasan a ser ${formatChapterList(later.map((n) => n + 1))}: los textos escritos por la IA (páginas, ruta de aprendizaje, cuerpo del Libro, juegos y videos) que nombran esos números no se reescriben.`);
}

/** Inserta las actividades del capítulo (y renumera los posteriores). Exportada para `add_module`. */
export async function insertChapter(ctx: OpContext, texts: Texts, a: { t: TemplateChapter; pl: ChapterPlacement; pieces: Array<{ piece: ChapterPiece; activity: WorkshopActivity }>; p: ProducedChapter; title: string; renumber?: boolean; unitExams?: Map<number, number>; noVideo?: boolean }): Promise<InsertedChapter> {
  const { t, pl, pieces, p } = a;
  const P = p.chapterNumber;
  if (a.renumber !== false) await renumberChapters(ctx, texts, P, pl);
  const alloc = await ctx.ids();
  await reserveAttributeIds(ctx, alloc);
  const takeSco = () => { const v = alloc.takeSco('sco'); (ctx.report.idsAssigned.sco ||= []).push(v); return v; };
  const libro = ctx.inv.activities.find((x) => x.kind === 'libro' && !x.missingFolder) ?? null;
  // ids nuevos por actividad (antes de escribir, para los tokens entre ellas).
  const plan = pieces.map(({ piece, activity }) => ({ piece, src: activity, mid: alloc.take('moduleid') }));
  const midOf = new Map(plan.map((x) => [x.src.moduleId, x.mid]));
  const scorm = plan.find((x) => x.piece === 'game')!;
  // CTA reescritos igual que el builder (`rewriteCtaLinks`): placeholders del contenido de la IA → tokens reales.
  // P1-5: el bloque del video de la página (CC_VIDEO_SLOT, lo pide pHTML) → el reproductor del hvp NUEVO si el molde
  // lo embebe así; si no, se quita. Nunca queda «Video en preparación» ni el marcador sin resolver.
  const hvpNew = plan.find((x) => x.piece === 'video');
  const templateEmbeds = t.activities.some((x) => x.html.some((h) => /\$@HVPEMBEDBYID\*\d+@\$/.test(h.html)));
  const slots = (html: string): string => html.replace(SLOT_RE, () => (hvpNew && templateEmbeds ? hvpEmbedHtml(hvpNew.mid) : ''));
  const rewrite = (html: string): string => slots(html)
    .replace(/#scorm-cap-(\d+)/g, (m, n: string) => (Number(n) === P ? `$@SCORMVIEWBYID*${scorm.mid}@$` : m))
    .replace(/#libro-guia/g, (m) => (libro ? `$@RESOURCEVIEWBYID*${libro.moduleId}@$` : m))
    .replace(/#exam-unit-(\d+)/g, (m, u: string) => { const q = a.unitExams?.get(Number(u)); return q ? `$@QUIZVIEWBYID*${q}@$` : m; });
  const newTitle = a.title;
  const tName = t.title;
  /** Nombre del builder del capítulo nuevo a partir del del molde. */
  const nameOf = (name: string): string => {
    let s = name;
    const r1 = replaceLit(s, tName, newTitle);
    s = r1.out;
    if (!r1.n && s.endsWith('…')) {
      const pre = s.slice(0, -1);
      const k = pre.lastIndexOf(' — ');
      const k2 = pre.lastIndexOf(': ');
      const cut = Math.max(k >= 0 ? k + 3 : -1, k2 >= 0 ? k2 + 2 : -1);
      if (cut > 0 && tName.startsWith(pre.slice(cut))) s = pre.slice(0, cut) + newTitle;
    }
    s = renumberName(s, t.number, P);
    return safeActivityName(s);
  };
  /** HTML de plantilla del molde → el del capítulo nuevo (número, título, módulo, archivos, tokens). */
  const fromTemplate = (html: string, what: string): string => {
    let s = html;
    const r1 = replaceLit(s, htmlEsc(tName), htmlEsc(newTitle));
    s = r1.out;
    if (t.moduleNumber !== null && t.moduleNumber !== pl.moduleNumber) {
      s = s.replace(new RegExp(`MÓDULO ${t.moduleNumber}(?!\\d)`, 'g'), `MÓDULO ${pl.moduleNumber}`);
      if (t.moduleTitle && pl.moduleTitle) s = replaceLit(s, htmlEsc(t.moduleTitle), htmlEsc(pl.moduleTitle)).out;
    }
    s = s.replace(new RegExp(`(>Cap[ií]tulo )${t.number}(<)`, 'g'), (_m, x: string, y: string) => `${x}${P}${y}`)
      .replace(new RegExp(`(· CAP[IÍ]TULO )${t.number}(?!\\d)`, 'g'), (_m, x: string) => `${x}${P}`)
      .replace(new RegExp(`@@PLUGINFILE@@/cap${t.number}_`, 'g'), `@@PLUGINFILE@@/cap${P}_`)
      .replace(/\$@([A-Z0-9]+)\*(\d+)@\$/g, (m, k: string, id: string) => (midOf.has(Number(id)) ? `$@${k}*${midOf.get(Number(id))}@$` : m));
    if (s.includes(htmlEsc(tName)) || (tName !== newTitle && !r1.n && what !== 'cta')) throw new PatchError('unsupported', `La plantilla de ${what} del molde no tiene el título del capítulo donde lo pone el builder: no se reescribe a ciegas.`);
    for (const m of t.activities) if (new RegExp(`\\*${m.moduleId}@\\$`).test(s)) throw new PatchError('invariant', `La ${what} nueva todavía apunta a una actividad del capítulo molde.`);
    return s;
  };

  // Sin video, el texto del capítulo es la página del capítulo con el nombre que le pone el builder (friendlyName).
  const pageName = safeActivityName(`▶️ Cap. ${P} — Video: ${newTitle}`);
  const textAsPage = (piece: ChapterPiece) => piece === 'text' && !!a.noVideo && (t.activities.find((x) => x.role === 'text')?.html.find((h) => h.field === 'intro')?.html ?? '').includes(V1_TEMPLATE_SIGNATURES.videoIntro);
  const files = await texts.get('files.xml');
  let filesOut = files;
  const newFileBlocks: string[] = [];
  const backup0 = await texts.get('moodle_backup.xml');
  let backup = backup0;
  const added: number[] = [];

  for (const x of plan) {
    const src = x.src;
    const dir = `activities/${src.modname}_${x.mid}`;
    if (ctx.state.has(`${dir}/module.xml`)) throw new PatchError('invariant', `Ya existe ${dir}.`);
    const newCtx = alloc.take('contextid');
    const aid = alloc.take('activity');
    const idMap = new Map<number, number>([[src.moduleId, x.mid]]);
    if (src.contextId !== null) idMap.set(src.contextId, newCtx);
    const entries = ctx.state.names().filter((n) => n.startsWith(`${src.dir}/`));
    const raw = new Map<string, string>();
    for (const e of entries) raw.set(e.slice(src.dir.length + 1), await ctx.state.readText(e));
    const main = raw.get(`${src.modname}.xml`);
    if (!main) throw new PatchError('unsupported', `${src.dir} no trae ${src.modname}.xml.`);
    const actId = Number(/<activity id="(\d+)"/.exec(main)?.[1]);
    if (!Number.isInteger(actId)) throw new PatchError('unsupported', `${src.dir}/${src.modname}.xml no trae <activity id>.`);
    if (!idMap.has(actId)) idMap.set(actId, aid);
    // Ids de la carpeta: atributos id="N" (sco / sco_data en su rango) + grade_item.
    for (const [, xml] of raw) {
      for (const m of xml.matchAll(/<(sco|sco_data|sco_track|seq_[a-z_]+)\s+id="(\d+)"/g)) if (!idMap.has(Number(m[2]))) idMap.set(Number(m[2]), takeSco());
      for (const m of xml.matchAll(/\bid="(\d+)"/g)) if (!idMap.has(Number(m[1]))) idMap.set(Number(m[1]), alloc.take('activity_item'));
    }
    // files.xml: las entradas del contexto del molde → entradas nuevas (contenido nuevo donde corresponde).
    const fileMap = new Map<number, number>();
    const srcFiles = src.contextId === null ? [] : [...files.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)].filter((m) => m[2].includes(`<contextid>${src.contextId}</contextid>`));
    const content = await contentFor(ctx, x.piece, src, p, t.number, P);
    for (const m of srcFiles) {
      const fid = alloc.take('file');
      fileMap.set(Number(m[1]), fid);
      let body = m[2].replace(`<contextid>${src.contextId}</contextid>`, `<contextid>${newCtx}</contextid>`);
      const fname = xmlUnescape(/<filename>([^<]*)<\/filename>/.exec(body)?.[1] ?? '');
      const area = /<filearea>([^<]*)<\/filearea>/.exec(body)?.[1] ?? '';
      const repl = content.files.find((f) => f.match(area, fname));
      if (repl) {
        const h = sha1Of(repl.data);
        const be = blobPath(h);
        if (!ctx.state.has(be)) { ctx.state.write(be, repl.data); ctx.report.entriesAdded.push(be); }
        body = body.replace(/<contenthash>[0-9a-f]{40}<\/contenthash>/, `<contenthash>${h}</contenthash>`)
          .replace(/<filesize>\d+<\/filesize>/, `<filesize>${repl.data.length}</filesize>`)
          .replace(/<filename>[^<]*<\/filename>/, `<filename>${xmlEsc(repl.filename)}</filename>`);
        repl.used = true;
      } else if (fname !== '.') {
        throw new PatchError('unsupported', `El molde ${src.dir} trae el archivo «${fname}» y el capítulo nuevo no tiene con qué reemplazarlo.`);
      }
      newFileBlocks.push(`<file id="${fid}">${body}</file>`);
    }
    const unused = content.files.filter((f) => !f.used);
    if (unused.length) throw new PatchError('unsupported', `El molde ${src.dir} no trae los archivos ${unused.map((f) => f.filename).join(', ')}.`);
    // XML de la carpeta con ids nuevos.
    const remap = (xml: string): string => xml
      .replace(/\b(id|moduleid|contextid)="(\d+)"/g, (mm, k: string, v: string) => (idMap.has(Number(v)) ? `${k}="${idMap.get(Number(v))}"` : mm))
      .replace(/(<file>\s*<id>)(\d+)(<\/id>\s*<\/file>)/g, (mm, a1: string, v: string, c: string) => { const nv = fileMap.get(Number(v)); if (nv === undefined) throw new PatchError('invariant', `${src.dir}: inforef nombra el archivo ${v}, que no es de la actividad.`); return `${a1}${nv}${c}`; })
      .replace(/(<grade_item>\s*<id>)(\d+)(<\/id>\s*<\/grade_item>)/g, (mm, a1: string, v: string, c: string) => (idMap.has(Number(v)) ? `${a1}${idMap.get(Number(v))}${c}` : mm))
      .replace(/(<iteminstance>)(\d+)(<\/iteminstance>)/g, (mm, a1: string, v: string, c: string) => (idMap.has(Number(v)) ? `${a1}${idMap.get(Number(v))}${c}` : mm))
      .replace(/(<launch>)(\d+)(<\/launch>)/g, (mm, a1: string, v: string, c: string) => (idMap.has(Number(v)) ? `${a1}${idMap.get(Number(v))}${c}` : mm));
    for (const [rel, xml0] of raw) {
      let xml = remap(xml0);
      if (rel === 'module.xml') {
        xml = editTag(xml, 'sectionid', () => String(pl.sectionId));
        xml = editTag(xml, 'sectionnumber', () => String(pl.sectionNumber));
        if (!/<availability>\$@NULL@\$<\/availability>|<availability><\/availability>/.test(xml) && /<availability>/.test(xml)) throw new PatchError('unsupported', `${src.dir} tiene condiciones de acceso: no se clona.`);
      }
      // P2-2: el slug del hvp lleva el número del capítulo (como el builder: interactive-video-N).
      if (rel === 'hvp.xml') xml = xml.replace(/<slug>interactive-video-\d+<\/slug>/, `<slug>interactive-video-${P}</slug>`);
      if (rel === `${src.modname}.xml`) xml = await rewriteMain(xml, { piece: x.piece, src, content, nameOf: textAsPage(x.piece) ? () => pageName : nameOf, fromTemplate, rewrite, p, P, asPage: textAsPage(x.piece) });
      if (rel === 'grades.xml') xml = editTag(xml, 'itemname', (v) => xmlEsc(nameOf(xmlUnescape(v))), true);
      // Ningún id del molde queda en la carpeta nueva.
      for (const m of xml.matchAll(/\b(?:id|moduleid|contextid)="(\d+)"/g)) if (!([...idMap.values()] as number[]).includes(Number(m[1]))) throw new PatchError('invariant', `${dir}/${rel}: quedó el id ${m[1]} del molde.`);
      const e = `${dir}/${rel}`;
      ctx.state.write(e, xml);
      ctx.report.entriesAdded.push(e);
    }
    for (const [k, v] of [['moduleid', x.mid], ['contextid', newCtx]] as const) (ctx.report.idsAssigned[k] ||= []).includes(v) || ctx.report.idsAssigned[k].push(v);
    // moodle_backup.xml: <activity> y sus <setting>.
    const blk = new RegExp(`(\\s*)<activity>\\s*<moduleid>${src.moduleId}</moduleid>[\\s\\S]*?</activity>`).exec(backup);
    if (!blk) throw new PatchError('invariant', `moodle_backup.xml no lista ${src.dir}.`);
    const newName = textAsPage(x.piece) ? pageName : nameOf(src.title);
    const nb = blk[0]
      .replace(`<moduleid>${src.moduleId}</moduleid>`, `<moduleid>${x.mid}</moduleid>`)
      .replace(/<sectionid>\d+<\/sectionid>/, `<sectionid>${pl.sectionId}</sectionid>`)
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${xmlEsc(newName)}</title>`)
      .replace(`<directory>${src.dir}</directory>`, `<directory>${dir}</directory>`);
    // Orden de <activities>: el de la secuencia (después de la actividad que precede al capítulo nuevo).
    const secNow = ctx.inv.sections.find((z) => z.id === pl.sectionId);
    const prevMid = added.length ? added[added.length - 1] : secNow && pl.sequenceIndex > 0 ? secNow.sequence[pl.sequenceIndex - 1] : null;
    const anchor = (prevMid !== null ? new RegExp(`<activity>\\s*<moduleid>${prevMid}</moduleid>[\\s\\S]*?</activity>`).exec(backup) : null) ?? blk;
    const at = (anchor!.index ?? 0) + anchor![0].length;
    backup = backup.slice(0, at) + nb + backup.slice(at);
    const key = `${src.modname}_${src.moduleId}`;
    const sets = [...backup.matchAll(new RegExp(`(\\s*)<setting>\\s*<level>activity</level>\\s*<activity>${key}</activity>[\\s\\S]*?</setting>`, 'g'))];
    if (sets.length) {
      const last = sets[sets.length - 1];
      const ins2 = sets.map((m) => m[0].split(`>${key}<`).join(`>${src.modname}_${x.mid}<`).split(`>${key}_`).join(`>${src.modname}_${x.mid}_`)).join('');
      const at2 = (last.index ?? 0) + last[0].length;
      backup = backup.slice(0, at2) + ins2 + backup.slice(at2);
    }
    added.push(x.mid);
  }
  filesOut = filesOut.replace(/<\/files>\s*$/, `${newFileBlocks.join('')}</files>`);
  if (!filesOut.includes(newFileBlocks[0] ?? '')) throw new PatchError('invariant', 'files.xml no cierra en </files>.');
  await texts.set('files.xml', filesOut);
  await texts.set('moodle_backup.xml', backup);
  // section.xml: <sequence>.
  // (sección nueva de `add_module`: la secuencia la escribe quien la crea)
  const sec = ctx.inv.sections.find((s) => s.id === pl.sectionId);
  if (sec) {
    if (!sec.entry) throw new PatchError('invariant', `La sección ${pl.sectionId} no tiene section.xml.`);
    const sx = await texts.get(sec.entry);
    const seq = sec.sequence.slice();
    seq.splice(pl.sequenceIndex, 0, ...added);
    await texts.set(sec.entry, editTag(sx, 'sequence', () => seq.join(',')));
  }
  return { number: P, moduleIds: added, scormModuleId: scorm.mid };
}

/** Archivos de contenido nuevo de una pieza (qué entrada del molde reemplaza cada uno). */
interface ContentFile { match: (area: string, name: string) => boolean; filename: string; data: Buffer; used?: boolean }
interface PieceContent { files: ContentFile[]; scormZipName?: string; zipHash?: string; manifestIds?: ReturnType<typeof parseScormManifestIds> }

async function contentFor(ctx: OpContext, piece: ChapterPiece, src: WorkshopActivity, p: ProducedChapter, tn: number, P: number): Promise<PieceContent> {
  void ctx;
  if (piece === 'presentation') {
    const pres = p.presentation!;
    return { files: [
      { match: (a, n) => a === 'intro' && /\.pdf$/i.test(n), filename: `cap${P}_presentacion.pdf`, data: pres.pdf },
      { match: (a, n) => a === 'intro' && /\.png$/i.test(n), filename: `cap${P}_portada.png`, data: pres.cover },
    ] };
  }
  if (piece === 'game') {
    const ids = parseScormManifestIds(p.scorm.manifestXml);
    const launch = ids.launch;
    const z = new JSZip();
    const date = new Date(Date.UTC(2026, 0, 1));
    z.file(launch, p.scorm.html, { date, createFolders: false });
    z.file('imsmanifest.xml', p.scorm.manifestXml, { date, createFolders: false });
    const zip = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const zipName = `scorm_cap${P}.zip`;
    const hasIndex = src.files.some((f) => f.filearea === 'content' && f.filename.toLowerCase() === launch.toLowerCase());
    if (!hasIndex) throw new PatchError('unsupported', `El juego molde no trae «${launch}».`);
    void tn;
    return { files: [
      { match: (a, n) => a === 'content' && n.toLowerCase() === launch.toLowerCase(), filename: launch, data: Buffer.from(p.scorm.html, 'utf8') },
      { match: (a, n) => a === 'content' && /^imsmanifest\.xml$/i.test(n), filename: 'imsmanifest.xml', data: Buffer.from(p.scorm.manifestXml, 'utf8') },
      { match: (a, n) => a === 'package' && /\.zip$/i.test(n), filename: zipName, data: zip },
    ], scormZipName: zipName, zipHash: sha1Of(zip), manifestIds: ids };
  }
  return { files: [] };
}

async function rewriteMain(xml: string, a: { piece: ChapterPiece; src: WorkshopActivity; content: PieceContent; nameOf: (n: string) => string; fromTemplate: (h: string, w: string) => string; rewrite: (h: string) => string; p: ProducedChapter; P: number; asPage?: boolean }): Promise<string> {
  const { piece, p } = a;
  let out = editTag(xml, 'name', (v) => xmlEsc(a.nameOf(xmlUnescape(v))));
  const intro = xmlUnescape(/<intro>([\s\S]*?)<\/intro>/.exec(xml)?.[1] ?? '');
  let html: string;
  switch (piece) {
    case 'presentation':
      if (!intro.includes(V1_TEMPLATE_SIGNATURES.presentation)) throw new PatchError('unsupported', 'La presentación del molde no es la tarjeta del builder.');
      html = a.fromTemplate(intro, 'presentación');
      break;
    case 'text':
      html = a.asPage ? a.rewrite(p.videoPageHtml as string) : intro.includes(V1_TEMPLATE_SIGNATURES.videoIntro) ? a.fromTemplate(intro, 'introducción del video') : a.rewrite(p.videoPageHtml as string);
      break;
    case 'video': {
      html = intro.includes(V1_TEMPLATE_SIGNATURES.videoIntro) ? a.fromTemplate(intro, 'introducción del video') : a.rewrite(p.videoPageHtml as string);
      const i0 = out.indexOf('<json_content>');
      const i1 = out.indexOf('</json_content>');
      if (i0 < 0 || i1 < 0) throw new PatchError('unsupported', 'El video molde no tiene <json_content>.');
      out = out.slice(0, i0 + '<json_content>'.length) + xmlEsc(p.video!.hvpJson) + out.slice(i1);
      break;
    }
    case 'cta':
      html = intro.includes(V1_TEMPLATE_SIGNATURES.cta) ? a.fromTemplate(intro, 'cta') : a.rewrite(p.gamePageHtml as string);
      break;
    case 'game': {
      html = intro.trim() === V1_TEMPLATE_SIGNATURES.scormDefaultIntro || intro.trim() === '' ? intro : a.rewrite(p.gamePageHtml as string);
      const ids = a.content.manifestIds!;
      out = editTag(out, 'reference', () => xmlEsc(a.content.scormZipName!));
      if (/<sha1hash>[0-9a-f]*<\/sha1hash>/.test(out)) out = editTag(out, 'sha1hash', () => a.content.zipHash!);
      const name = xmlUnescape(/<name>([\s\S]*?)<\/name>/.exec(out)?.[1] ?? '');
      out = out.replace(/<scoes>[\s\S]*<\/scoes>/, (sc) => {
        const blocks = [...sc.matchAll(/<sco id="\d+">[\s\S]*?<\/sco>/g)];
        if (blocks.length !== 2) throw new PatchError('unsupported', `El juego molde tiene ${blocks.length} sco (se esperaban 2).`);
        const set = (blk: string, kv: Record<string, string>) => Object.entries(kv).reduce((acc, [k, v]) => editTag(acc, k, () => xmlEsc(v)), blk);
        const org = set(blocks[0][0], { manifest: ids.manifest, identifier: ids.organization, title: name });
        const item = set(blocks[1][0], { manifest: ids.manifest, organization: ids.organization, parent: ids.organization, identifier: ids.item, launch: ids.launch, title: name });
        return sc.replace(blocks[1][0], () => item).replace(blocks[0][0], () => org);
      });
      break;
    }
    default:
      throw new PatchError('unsupported', `Pieza «${piece}» fuera del patrón del capítulo.`);
  }
  if (hasPendingMarker(html)) throw new PatchError('invalid_content', 'La actividad nueva trae un «⚠️ Pendiente».');
  if (VIDEO_PENDING_RE.test(html)) throw new PatchError('invalid_content', 'La actividad nueva trae el marcador «Video en preparación» o el bloque del video sin resolver.');
  const i0 = out.indexOf('<intro>');
  const i1 = out.indexOf('</intro>');
  if (i0 < 0 || i1 < 0) throw new PatchError('unsupported', `${a.src.dir}: sin <intro>.`);
  return out.slice(0, i0 + '<intro>'.length) + xmlEsc(html) + out.slice(i1);
}

/** `contextid="N"` y `moduleid="N"` (atributos) no los ve el escaneo general: se reservan para no repetirlos. */
async function reserveAttributeIds(ctx: OpContext, alloc: IdAllocator): Promise<void> {
  const xs: number[] = [];
  for (const n of ctx.state.names()) {
    if (!/\.xml$/i.test(n)) continue;
    const x = await ctx.state.readText(n);
    for (const m of x.matchAll(/\b(?:contextid|moduleid|instanceid|contextinstanceid)="(\d{1,15})"/g)) xs.push(Number(m[1]));
  }
  alloc.reserve(xs);
}

// ─── Renumeración de los capítulos posteriores ──────────────────────────────

/** Capítulos ≥ `from` suben uno donde el builder pone el número. Se hace de mayor a menor (sin choques). */
export async function renumberChapters(ctx: OpContext, texts: Texts, from: number, pl: { moduleNumber: number } | null): Promise<void> {
  const later = ctx.inv.chapters.filter((c) => c.number >= from).sort((a, b) => b.number - a.number);
  let backup = await texts.get('moodle_backup.xml');
  for (const ch of later) {
    const n = ch.number;
    for (const id of ch.activities) {
      const a = ctx.inv.activities.find((x) => x.moduleId === id);
      if (!a || a.missingFolder) continue;
      backup = backup.replace(new RegExp(`(<activity>\\s*<moduleid>${id}</moduleid>[\\s\\S]*?<title>)([\\s\\S]*?)(</title>)`), (_m, x: string, v: string, y: string) => `${x}${xmlEsc(renumberName(xmlUnescape(v), n, n + 1))}${y}`);
      const main = `${a.dir}/${a.modname}.xml`;
      let mx = await texts.get(main);
      mx = editTag(mx, 'name', (v) => xmlEsc(renumberName(xmlUnescape(v), n, n + 1)));
      if (a.modname === 'hvp') mx = mx.replace(new RegExp(`<slug>interactive-video-${n}</slug>`), `<slug>interactive-video-${n + 1}</slug>`);
      if (a.modname === 'scorm') mx = mx.replace(/<scoes>[\s\S]*<\/scoes>/, (sc) => editTag(sc, 'title', (v) => xmlEsc(renumberName(xmlUnescape(v), n, n + 1)), true));
      const iA = mx.indexOf('<intro>');
      const iB = mx.indexOf('</intro>');
      if (iA >= 0 && iB > iA) {
        const intro = mx.slice(iA, iB);
        const sig = [V1_TEMPLATE_SIGNATURES.presentation, V1_TEMPLATE_SIGNATURES.videoIntro].some((s) => intro.includes(xmlEsc(s)));
        if (sig) mx = mx.slice(0, iA) + renumberTemplateBadgesRaw(intro, n, n + 1).out + mx.slice(iB);
      }
      await texts.set(main, mx);
      const ge = `${a.dir}/grades.xml`;
      if (ctx.state.has(ge)) await texts.set(ge, editTag(await texts.get(ge), 'itemname', (v) => xmlEsc(renumberName(xmlUnescape(v), n, n + 1)), true));
    }
  }
  await texts.set('moodle_backup.xml', backup);
  // Resumen «Capítulos 1, 2 y 3 con …» de las secciones de módulo (lo escribe el builder).
  for (const s of ctx.inv.sections) {
    if (s.kind !== 'module' || !s.entry) continue;
    const sx = await texts.get(s.entry);
    const m = /<summary>Capítulos ([\d, y]+?) con /.exec(sx);
    if (!m) continue;
    const list = parseChapterList(m[1]);
    if (!list) continue;
    let next = list.map((n) => (n >= from ? n + 1 : n));
    if (pl && s.moduleNumber === pl.moduleNumber) next = [...next, from].sort((x, y) => x - y);
    if (JSON.stringify(next) !== JSON.stringify(list)) await texts.set(s.entry, sx.replace(m[0], `<summary>Capítulos ${formatChapterList(next)} con `));
  }
}

// ─── Libro Guía HTML ────────────────────────────────────────────────────────

/** Cuerpo HTML del capítulo a partir del markdown del generador del Libro (sin su título: lo pone el motor). */
export function libroBodyOf(md: string): string {
  const html = mdToHtmlBasic(md.replace(/^\s*```(?:markdown)?\s*/i, '').replace(/\s*```\s*$/, ''));
  return html.replace(/^\s*<h[1-3]>\s*Cap[ií]tulo\s+\d+[^<]*<\/h[1-3]>\s*/i, '');
}

/** Renumera títulos «Capítulo N:» y el índice (`te tc`) del Libro, inserta la entrada y la sección del capítulo nuevo. */
export function insertIntoLibroHtml(html: string, a: { position: number; title: string; body: string; moduleOf: (n: number) => number | null; moduleNumber: number }): { html: string; notes: string[] } {
  const P = a.position;
  if (!/<\/html>\s*$/i.test(html)) throw new PatchError('unavailable', 'El Libro Guía del paquete está cortado: primero hay que recomponerlo (edit_libro_section).');
  const st0 = libroStructure(html);
  if (!st0.chapters.length) throw new PatchError('unavailable', 'El Libro Guía no tiene títulos de capítulo con el formato del builder («Capítulo N: …»): no se puede insertar el capítulo nuevo con certeza.');
  const bump = (n: number) => (n >= P ? n + 1 : n);
  let out = html.replace(/<h([1-3])\b([^>]*)>(\s*Cap[ií]tulo\s+)(\d{1,3})(\s*[:—–-])/gi, (_m, l: string, at: string, pre: string, n: string, post: string) => `<h${l}${at}>${pre}${bump(Number(n))}${post}`);
  let toc = 0;
  out = out.replace(/(<span class="tt">Cap[ií]tulo )(\d{1,3})(:)/g, (_m, pre: string, n: string, post: string) => { toc++; return `${pre}${bump(Number(n))}${post}`; });
  const notes: string[] = [];
  if (toc) {
    const entry = `<div class="te tc"><span class="tt">Capítulo ${P}: ${htmlEsc(a.title)}</span><span class="td"></span></div>`;
    const prev = new RegExp(`<div class="te tc"><span class="tt">Capítulo ${P - 1}:[\\s\\S]*?</div>`).exec(out);
    const next = new RegExp(`<div class="te tc"><span class="tt">Capítulo ${P + 1}:`).exec(out);
    const at = prev && (a.moduleOf(P - 1) === a.moduleNumber || !next) ? (prev.index ?? 0) + prev[0].length : next ? next.index ?? 0 : -1;
    if (at < 0) throw new PatchError('unsupported', 'No se encontró dónde va el capítulo en el índice del Libro.');
    out = out.slice(0, at) + entry + out.slice(at);
    notes.push(`índice del Libro: entrada «Capítulo ${P}» agregada y ${toc} entrada(s) renumerada(s) donde correspondía`);
  } else notes.push('el Libro no tiene índice con el formato del builder: solo se insertó la sección');
  const moduleOf = (n: number) => (n === P ? a.moduleNumber : a.moduleOf(n > P ? n - 1 : n));
  const res = recomposeLibro(out, { op: 'edit_libro_section', moduleId: 0, chapters: [{ number: P, html: a.body, title: a.title }] }, () => a.title, [], moduleOf);
  const seq = libroChapterSequence(res.html);
  if (!/<\/html>\s*$/i.test(res.html) || !seq.reliable || !seq.numbers.includes(P)) throw new PatchError('invariant', 'El Libro resultante no quedó con sus capítulos en orden.');
  return { html: res.html, notes: [...notes, ...res.notes] };
}

export async function insertLibroChapter(ctx: OpContext, texts: Texts, a: { position: number; title: string; md: string; moduleOf: (n: number) => number | null; moduleNumber: number }): Promise<void> {
  void texts;
  const libro = ctx.inv.activities.find((x) => x.kind === 'libro' && !x.missingFolder && x.modname === 'resource');
  if (!libro) throw new PatchError('unavailable', 'El curso no tiene Libro Guía HTML en el paquete: no se agrega un capítulo que el Libro no tendría.');
  const lf = libro.files.find((f) => f.filearea === 'content' && /\.html?$/i.test(f.filename));
  if (!lf) throw new PatchError('unavailable', 'El Libro Guía del curso no es HTML (es un PDF): agregar el capítulo al Libro no está disponible en este formato.');
  // El blob ACTUAL del Libro (otra inserción de este mismo plan / módulo pudo cambiarlo): el de files.xml.
  const fx0 = await texts.get('files.xml');
  const mine = (body: string) => libro.contextId !== null && body.includes(`<contextid>${libro.contextId}</contextid>`) && body.includes(`<filename>${xmlEsc(lf.filename)}</filename>`) && body.includes(`<filearea>${lf.filearea}</filearea>`);
  const cur = [...fx0.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)].find((m) => mine(m[2]));
  const curHash = cur ? /<contenthash>([0-9a-f]{40})<\/contenthash>/.exec(cur[2])?.[1] ?? null : null;
  if (!curHash || !ctx.state.has(blobPath(curHash))) throw new PatchError('target_not_found', 'El archivo del Libro no viene en el paquete.');
  const buf = await ctx.state.read(blobPath(curHash));
  if (sha1Of(buf) !== curHash) throw new PatchError('stale_target', 'El blob del Libro no coincide con su sha1.');
  const res = insertIntoLibroHtml(buf.toString('utf8'), { ...a, body: libroBodyOf(a.md) });
  const outBuf = Buffer.from(res.html, 'utf8');
  const nh = sha1Of(outBuf);
  if (!ctx.state.has(blobPath(nh))) { ctx.state.write(blobPath(nh), outBuf); ctx.report.entriesAdded.push(blobPath(nh)); }
  const fixed = fx0.replace(/<file id="(\d+)">([\s\S]*?)<\/file>/g, (m, id: string, body: string) => {
    // P2-4: SOLO la entrada del Libro (otro archivo con el mismo contenido no se toca).
    if (!mine(body) || !body.includes(`<contenthash>${curHash}</contenthash>`)) return m;
    if (curHash === lf.contenthash) ctx.report.files.push({ fileId: Number(id), filename: lf.filename, component: lf.component, filearea: lf.filearea, before: { contenthash: lf.contenthash, filesize: lf.filesize, mimetype: lf.mimetype }, after: { contenthash: nh, filesize: outBuf.length, mimetype: lf.mimetype } });
    else for (const f of ctx.report.files) if (f.fileId === Number(id)) f.after = { contenthash: nh, filesize: outBuf.length, mimetype: lf.mimetype };
    return `<file id="${id}">${body.replace(`<contenthash>${curHash}</contenthash>`, `<contenthash>${nh}</contenthash>`).replace(/<filesize>\d+<\/filesize>/, `<filesize>${outBuf.length}</filesize>`)}</file>`;
  });
  await texts.set('files.xml', fixed);
  if (!fixed.includes(`<contenthash>${curHash}</contenthash>`)) {
    ctx.state.remove(blobPath(curHash));
    const k = ctx.report.entriesAdded.indexOf(blobPath(curHash));
    if (k >= 0) ctx.report.entriesAdded.splice(k, 1); else ctx.report.entriesRemoved.push(blobPath(curHash));
  }
  ctx.report.fields.push({ entry: blobPath(nh), field: `file:${lf.filename}`, moduleId: libro.moduleId, sectionId: null, before: `[Libro ${lf.contenthash}, capítulos ${ctx.inv.chapters.map((c) => c.number).join(', ')}]`, after: `[Libro ${nh}, con el capítulo ${a.position} «${a.title}»]`, beforeRawSha1: lf.contenthash, afterRawSha1: nh });
  ctx.report.notes.push(...res.notes);
}

export { Texts, reEsc, editTag, htmlEsc, replaceLit };
