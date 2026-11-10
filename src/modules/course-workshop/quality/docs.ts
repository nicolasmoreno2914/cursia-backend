/**
 * r107 B8 · Textos del curso para la calidad: CADA texto que el estudiante lee, en texto plano, con su actividad, su
 * capítulo y qué es. Sale del MISMO contexto que el diagnóstico técnico de B3 (inventario con HTML + blobs verificados:
 * Libro Guía HTML por capítulo, contenido de los videos H5P / hvp, HTML de los juegos SCORM, preguntas de examen), así
 * que la calidad nunca lee un archivo dañado (eso ya es un hallazgo técnico T02).
 *
 * Puro (sobre el contexto ya leído).
 */
import { WorkshopActivity, plainText } from '../course-model';
import { DiagnosisContext, blobVerified } from '../diagnosis/context';
import { humanName } from '../diagnosis/checks';
import { libroStructure } from '../patch/op-libro';
import { stringsOf } from '../../quality/course-quality-checks';
import type { QualityDoc, QualityDocRole } from './types';

const BIG = 400_000;
const chapterOf = (a: WorkshopActivity): number | null => (a.placement.scope === 'chapter' ? a.placement.chapterNumber : null);

/** Qué es la actividad, en español, para el docente. */
export function whatOf(a: WorkshopActivity, role: QualityDocRole): string {
  if (role === 'exam') return 'una pregunta del examen';
  if (role === 'libro') return 'el Libro Guía';
  if (role === 'video') return 'el video';
  if (role === 'game') return 'el juego';
  if (a.role === 'presentation') return 'la presentación';
  return 'el texto';
}

function roleOf(a: WorkshopActivity): QualityDocRole {
  if (a.kind === 'libro' || a.kind === 'libro_mobile') return 'libro';
  if (a.role === 'video' || a.modname === 'hvp') return 'video';
  if (a.role === 'game' || a.modname === 'scorm') return 'game';
  if (a.modname === 'quiz') return 'exam';
  if (a.role === 'text' || a.role === 'activity' || a.role === 'cta' || a.modname === 'label' || a.modname === 'page') return 'text';
  return 'other';
}

/** Claves técnicas de un content.json de H5P que no son texto para el estudiante. */
const H5P_SKIP = new Set(['library', 'subContentId', 'metadata', 'path', 'mime', 'copyright', 'license', 'contentType', 'id', 'type', 'kind',
  'correct', 'behaviour', 'l10n', 'overallFeedback', 'UI', 'a11y', 'scoreBarLabel', 'tipsLabel', 'checkAnswerButton', 'submitAnswerButton',
  'showSolutionButton', 'tryAgainButton', 'confirmCheck', 'confirmRetry', 'override', 'width', 'height', 'x', 'y', 'duration', 'from', 'to',
  'startScreenOptions', 'bookmarks', 'endscreens', 'visuals', 'pause', 'displayType', 'buttonOnMobile', 'goto', 'label', 'adaptivity', 'extraTitle', 'title']);

/** Texto plano de un content.json de H5P / json_content de hvp (los textos que ve el estudiante). */
export function h5pText(content: unknown): string {
  return stringsOf(content, H5P_SKIP).map((s) => plainText(s, 4_000)).filter((s) => s && !/^(https?:|data:|#|[\d.]+$)/.test(s)).join('\n');
}

/**
 * Texto plano que CONSERVA los cortes de bloque (párrafos, títulos, celdas, listas) como saltos de línea: una «oración»
 * nunca junta el encabezado de una etiqueta con su primer párrafo (las reglas por oración dependen de eso).
 */
const BLOCK_END = /<\/(?:p|div|h[1-6]|li|tr|td|th|section|article|header|footer|blockquote|figcaption|dt|dd)\s*>|<br\s*\/?>|<hr\b[^>]*>/gi;
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', iexcl: '¡', iquest: '¿', laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…' };
/** Entidades HTML → caracteres (el texto que ve el estudiante; lo que parezca una etiqueta lo neutraliza el prompt). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENTITIES[e] ?? m;
  });
}
export function blockText(html: string, max = BIG): string {
  return decodeEntities(plainText(String(html).replace(BLOCK_END, (m) => `${m}\uE000`), max * 2)).replace(/[^\S\n\uE000]+/g, ' ').replace(/\s*\uE000\s*/g, '\n').replace(/\n{2,}/g, '\n').trim().slice(0, max);
}

/** Número de capítulo que declara un texto al empezar («Capítulo 3: …» / «Capítulo 3 · …»). */
function declaredChapter(text: string): number | null {
  const m = /^\s*(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*)?Cap[ií]tulo\s+(\d{1,3})\b/iu.exec(text.slice(0, 200));
  return m ? Number(m[1]) : null;
}

/** Todos los textos del curso (determinista: mismo paquete → misma lista, en el orden del curso). */
export function qualityDocs(ctx: DiagnosisContext): QualityDoc[] {
  const out: QualityDoc[] = [];
  const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  /** Capítulo de un capítulo del Libro en línea (mod_book): el título de UN capítulo del curso aparece al empezar. */
  const bookChapterOf = (text: string): number | null => {
    const head = fold(text.slice(0, 400));
    const hits = ctx.course.chapters.filter((c) => c.title && c.title.trim().length >= 4 && head.includes(fold(c.title.trim())));
    return hits.length === 1 ? hits[0].number : null;
  };
  const moduleOfChapter = (n: number | null) => (n === null ? null : ctx.course.chapters.find((c) => c.number === n)?.moduleNumber ?? null);
  const push = (a: WorkshopActivity, d: Omit<QualityDoc, 'moduleId' | 'activityTitle' | 'what' | 'moduleNumber'> & { moduleNumber?: number | null }) => {
    const text = d.text.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
    if (text.length < 3) return;
    out.push({ ...d, text, moduleId: a.moduleId, activityTitle: humanName(a), what: whatOf(a, d.role), moduleNumber: d.moduleNumber ?? moduleOfChapter(d.chapterNumber) ?? a.unit ?? null });
  };
  for (const a of ctx.course.activities) {
    if (a.missingFolder) continue;
    const role = roleOf(a);
    const ch = chapterOf(a);
    // Campos HTML (etiquetas, páginas, descripciones, capítulos de un Libro en línea).
    for (const h of a.html) {
      if (h.field === 'externalurl') continue;
      const text = blockText(h.html);
      if (a.modname === 'book') {
        const n = declaredChapter(text) ?? bookChapterOf(text);
        push(a, { key: `a${a.moduleId}.${h.field}`, questionId: null, field: h.field, chapterNumber: n, role: 'libro', text });
      } else {
        push(a, { key: `a${a.moduleId}.${h.field}`, questionId: null, field: h.field, chapterNumber: ch, role: role === 'exam' || role === 'libro' ? 'other' : role, text });
      }
    }
    // Libro Guía HTML (recurso): un texto por capítulo, con su número.
    if (a.kind === 'libro' && a.modname === 'resource') {
      const f = a.files.find((x) => x.filearea === 'content' && /\.html?$/i.test(x.filename) && x.filename !== '.');
      const html = f && blobVerified(ctx, f.contenthash) ? ctx.texts.get(f.contenthash) : undefined;
      if (html) {
        const st = libroStructure(html);
        for (const c of st.chapters) {
          push(a, { key: `l${a.moduleId}.c${c.number}`, questionId: null, field: null, chapterNumber: c.number, role: 'libro', text: blockText(html.slice(c.headStart, c.bodyEnd)) });
        }
      }
    }
    // Videos y actividades H5P: el texto de sus interacciones.
    if (a.modname === 'hvp') {
      const j = ctx.hvp.get(a.moduleId);
      if (j && j.json) push(a, { key: `a${a.moduleId}.h5p`, questionId: null, field: null, chapterNumber: ch, role: 'video', text: h5pText(j.json) });
    }
    if (a.modname === 'h5pactivity') {
      const p = ctx.h5p.get(a.moduleId);
      if (p && p.content) push(a, { key: `a${a.moduleId}.h5p`, questionId: null, field: null, chapterNumber: ch, role: role === 'video' ? 'video' : 'game', text: h5pText(p.content) });
    }
    // Juegos SCORM: el texto de sus páginas (sin scripts ni estilos).
    if (a.modname === 'scorm') {
      const sc = ctx.scorm.get(a.moduleId);
      if (sc) {
        const t = [...sc.html.keys()].sort().map((k) => blockText(sc.html.get(k) as string)).join('\n');
        push(a, { key: `a${a.moduleId}.scorm`, questionId: null, field: null, chapterNumber: ch, role: 'game', text: t.slice(0, 40_000) });
      }
    }
    // Exámenes: una pregunta por texto (enunciado + opciones), con el capítulo que declara su categoría.
    if (a.exam) {
      for (const q of a.exam.questions) {
        const parts = [plainText(q.html, 4_000), ...q.answers.map((x) => plainText(x.html, 1_000)), ...q.matches.map((m) => `${plainText(m.html, 500)} → ${m.answer}`)];
        push(a, { key: `q${q.id}`, questionId: q.id, field: null, chapterNumber: q.chapterNumber, moduleNumber: a.exam.unit ?? (q.chapterNumber !== null ? moduleOfChapter(q.chapterNumber) : null), role: 'exam', text: parts.filter(Boolean).join(' · ') });
      }
    }
  }
  return out;
}
