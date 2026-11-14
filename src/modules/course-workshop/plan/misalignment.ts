/**
 * r107 B5 · Avisos de DESALINEACIÓN (D7: sin cascada automática). Un cambio arregla SU destino; lo que en otras
 * actividades del curso hable de lo mismo se AVISA — «el video del capítulo 2 todavía menciona «1990»» — con su
 * operación y su costo, para que el docente lo agregue como pedido aparte si quiere. Nunca se agregan solos.
 *
 * Sin IA, dos fuentes:
 *   1. Coincidencia de texto simple: los DATOS que el cambio saca (números de 2+ cifras y palabras de 5+ letras que
 *      estaban antes y ya no están después) se buscan en el resto del curso — campos HTML de las actividades, texto de
 *      los videos H5P (json_content), HTML de los juegos SCORM, Libro Guía HTML y preguntas de examen. Cada actividad
 *      donde aparece alguno = un aviso `text_match`.
 *   2. Referencias del inventario: (a) el mismo capítulo — si el cambio saca datos de un texto / capítulo del Libro /
 *      pregunta de un capítulo, el audio y la presentación de ese capítulo (sin texto que revisar) pueden seguir
 *      diciéndolo: aviso `same_chapter`; (b) quitar una actividad: las que tenían un botón hacia ella (`referencedBy`)
 *      quedan con el texto sin enlace: aviso `references`.
 *   Además, los avisos que ya da el motor de B4 en su informe (Libro en PDF que queda con el texto viejo, SCORM con el
 *   logo anterior…) se muestran como `engine`.
 *
 * Puro.
 */
import { createHash } from 'crypto';
import { WorkshopActivity, WorkshopCourse, plainText } from '../course-model';
import { activityOf } from './summary';
import { tagInner } from '../xml-scan';
import type { MisalignmentWarning, RequestOperation, ResolvedTarget } from './types';

/** Texto buscable de una actividad (o de una pregunta de examen). */
export interface SearchDoc {
  moduleId: number;
  source: 'html' | 'video' | 'scorm' | 'libro' | 'question';
  questionId: number | null;
  text: string;
}

const STOP = new Set(['sobre', 'entre', 'desde', 'hasta', 'donde', 'cuando', 'porque', 'según', 'mediante', 'durante', 'también', 'además', 'puede', 'pueden', 'tiene', 'tienen', 'estos', 'estas', 'aquel', 'otros', 'otras', 'cada', 'todos', 'todas', 'mismo', 'misma', 'siempre', 'nunca', 'capítulo', 'capitulo', 'módulo', 'modulo', 'actividad', 'curso', 'texto', 'video', 'ejemplo']);
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Datos que el cambio SACA (estaban antes y no después): números de 2+ cifras y palabras de 5+ letras. Máx. 8. */
export function removedTerms(before: string, after: string): string[] {
  const terms = (s: string) => {
    const nums = s.match(/\d[\d.,]*\d|\d{2,}/g) ?? [];
    const words = (s.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{5,}/g) ?? []).filter((w) => !STOP.has(fold(w)));
    return [...nums, ...words];
  };
  const afterSet = new Set(terms(after).map(fold));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of terms(before)) {
    const k = fold(t);
    if (afterSet.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  // Primero los números (los datos más típicos de una corrección), después las palabras con mayúscula.
  return out.sort((a, b) => Number(/\d/.test(b)) - Number(/\d/.test(a)) || Number(/^[A-ZÁÉÍÓÚÑ]/.test(b)) - Number(/^[A-ZÁÉÍÓÚÑ]/.test(a))).slice(0, 8);
}

const hasTerm = (text: string, term: string) => {
  const f = fold(text);
  const t = fold(term);
  if (/^\d/.test(t)) return new RegExp(`(^|[^0-9])${t.replace(/[.,]/g, '[.,]')}([^0-9]|$)`).test(f);
  return new RegExp(`(^|[^a-z0-9ñ])${t}([^a-z0-9ñ]|$)`).test(f);
};

const idOf = (...parts: Array<string | number | null>) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);

const whatEs = (a: WorkshopActivity, source: SearchDoc['source']): string => {
  if (source === 'question') return 'una pregunta de';
  if (source === 'libro' || a.kind === 'libro') return 'el Libro Guía';
  if (a.role === 'video' || source === 'video') return 'el video';
  if (a.role === 'game' || source === 'scorm') return 'el juego';
  if (a.role === 'presentation') return 'la presentación';
  return 'la actividad';
};

function opFor(a: WorkshopActivity, source: SearchDoc['source']): RequestOperation | null {
  if (source === 'question') return 'exam_question_replace';
  if (source === 'libro' || a.kind === 'libro') return a.modname === 'resource' ? 'edit_libro_section' : null;
  if (a.role === 'video' || source === 'video') return 'regenerate_video';
  if (a.role === 'game' || source === 'scorm') return 'regenerate_scorm';
  if (a.role === 'presentation') return 'regenerate_gamma';
  if (a.kind === 'audiobook' || a.kind === 'welcome_audio') return 'regenerate_audio';
  if (a.html.some((h) => h.field !== 'externalurl')) return 'edit_html';
  return null;
}

export interface MisalignmentInput {
  course: WorkshopCourse;
  operation: RequestOperation;
  target: ResolvedTarget;
  /** Texto plano antes / después del cambio (vacío si la operación no cambia texto). */
  before: string;
  after: string;
  docs: SearchDoc[];
  engineNotes: string[];
}

export function misalignmentWarnings(inp: MisalignmentInput): MisalignmentWarning[] {
  const out: MisalignmentWarning[] = [];
  const targetMid = 'moduleId' in inp.target ? inp.target.moduleId : 'quizModuleId' in inp.target ? inp.target.quizModuleId : null;
  const targetQid = inp.target.kind === 'question' ? inp.target.questionId : null;
  const targetChapters = inp.target.kind === 'libro' ? inp.target.chapters : [];
  const removed = removedTerms(inp.before, inp.after);
  const chapterOf = (a: WorkshopActivity) => (a.placement.scope === 'chapter' ? a.placement.chapterNumber : null);
  const label = (a: WorkshopActivity, source: SearchDoc['source']) => {
    const ch = chapterOf(a);
    return `${whatEs(a, source)}${source === 'question' ? ` «${a.title}»` : ch !== null ? ` del capítulo ${ch}` : ` «${a.title}»`}`;
  };

  // 1. Coincidencia de texto: una advertencia por actividad (o pregunta) donde aparece algún dato que se saca.
  if (removed.length) {
    const seen = new Set<string>();
    for (const d of inp.docs) {
      if (d.moduleId === targetMid && (d.source !== 'question' || d.questionId === targetQid) && d.source !== 'libro') continue;
      if (d.source === 'libro' && d.moduleId === targetMid && targetChapters.length) continue; // el Libro que se está editando
      const hits = removed.filter((t) => hasTerm(d.text, t));
      if (!hits.length) continue;
      const a = activityOf(inp.course, d.moduleId);
      if (!a) continue;
      const key = `${d.moduleId}|${d.source}|${d.questionId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const L = label(a, d.source);
      out.push({
        id: idOf('text_match', key, hits.join(',')),
        kind: 'text_match',
        activity: { moduleId: a.moduleId, title: a.title, modname: a.modname, chapterNumber: chapterOf(a) },
        questionId: d.source === 'question' ? d.questionId : null,
        message: `${L.charAt(0).toUpperCase()}${L.slice(1)} todavía menciona ${hits.slice(0, 3).map((t) => `«${t}»`).join(', ')}.`,
        terms: hits,
        suggestedOperation: opFor(a, d.source),
        estimate: null,
      });
    }
  }

  // 2a. Mismo capítulo: medios sin texto que revisar (audio, presentación) cuando el cambio saca datos de ese capítulo.
  const chapter = inp.target.kind === 'html' || inp.target.kind === 'question' || inp.target.kind === 'activity' ? inp.target.chapterNumber : null;
  const chapters = chapter !== null ? [chapter] : targetChapters;
  if (removed.length && inp.operation !== 'remove_activity') {
    for (const n of chapters) {
      const c = inp.course.chapters.find((x) => x.number === n);
      if (!c) continue;
      for (const role of ['presentation', 'audio'] as const) {
        for (const mid of c.roles[role] ?? []) {
          if (mid === targetMid || out.some((w) => w.activity?.moduleId === mid)) continue;
          const a = activityOf(inp.course, mid);
          if (!a) continue;
          out.push({
            id: idOf('same_chapter', mid, n),
            kind: 'same_chapter',
            activity: { moduleId: a.moduleId, title: a.title, modname: a.modname, chapterNumber: n },
            questionId: null,
            message: `${role === 'audio' ? 'El audio' : 'La presentación'} del capítulo ${n} puede seguir diciendo el dato anterior (no tiene texto que se pueda revisar sin rehacerla).`,
            terms: removed,
            suggestedOperation: role === 'audio' ? 'regenerate_audio' : 'regenerate_gamma',
            estimate: null,
          });
        }
      }
    }
    // El audiolibro del curso narra todos los capítulos.
    if (chapters.length) {
      for (const mid of inp.course.audiobook) {
        if (out.some((w) => w.activity?.moduleId === mid)) continue;
        const a = activityOf(inp.course, mid);
        if (!a) continue;
        out.push({
          id: idOf('same_chapter', mid, chapters.join(',')),
          kind: 'same_chapter',
          activity: { moduleId: a.moduleId, title: a.title, modname: a.modname, chapterNumber: null },
          questionId: null,
          message: `El audiolibro narra el capítulo ${chapters.join(', ')}: puede seguir diciendo el dato anterior.`,
          terms: removed,
          suggestedOperation: 'regenerate_audio',
          estimate: null,
        });
      }
    }
  }

  // 2b. Quitar una actividad: las que tenían un botón hacia ella quedan con el texto sin enlace.
  if (inp.operation === 'remove_activity' && targetMid !== null) {
    const t = activityOf(inp.course, targetMid);
    for (const mid of t?.referencedBy ?? []) {
      const a = activityOf(inp.course, mid);
      if (!a || mid === targetMid) continue;
      out.push({
        id: idOf('references', mid, targetMid),
        kind: 'references',
        activity: { moduleId: a.moduleId, title: a.title, modname: a.modname, chapterNumber: chapterOf(a) },
        questionId: null,
        message: `«${a.title}» tenía un botón hacia «${t!.title}»: queda el texto sin enlace; quizás convenga reescribirlo.`,
        terms: [],
        suggestedOperation: a.html.some((h) => h.field !== 'externalurl') ? 'edit_html' : null,
        estimate: null,
      });
    }
  }

  // 3. Lo que ya avisa el motor (B4).
  for (const n of inp.engineNotes) out.push({ id: idOf('engine', n), kind: 'engine', activity: null, questionId: null, message: n, terms: [], suggestedOperation: null, estimate: null });
  return out;
}

/** Texto buscable del curso (una vez por plan). `read(entry)` lee del paquete original. */
export async function searchDocs(course: WorkshopCourse, read: (entry: string) => Promise<Buffer | null>): Promise<SearchDoc[]> {
  const out: SearchDoc[] = [];
  const MAX = 400_000;
  for (const a of course.activities) {
    if (a.missingFolder) continue;
    const html = a.html.filter((h) => h.field !== 'externalurl').map((h) => plainText(h.html, MAX)).join('\n');
    if (html.trim()) out.push({ moduleId: a.moduleId, source: a.kind === 'libro' && a.modname !== 'resource' ? 'libro' : 'html', questionId: null, text: html });
    if (a.modname === 'hvp') {
      const b = await read(`${a.dir}/hvp.xml`);
      const m = b ? tagInner(b.toString('utf8'), 'json_content') : null;
      if (m !== null) out.push({ moduleId: a.moduleId, source: 'video', questionId: null, text: plainText(m.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\\u[0-9a-f]{4}/gi, (u) => String.fromCharCode(parseInt(u.slice(2), 16))), MAX) });
    }
    if (a.modname === 'scorm' || (a.kind === 'libro' && a.modname === 'resource')) {
      for (const f of a.files.filter((x) => x.filearea === 'content' && /\.(html?|js)$/i.test(x.filename) && x.blobPresent && x.filesize <= 3 * 1024 * 1024)) {
        const b = await read(f.blobEntry);
        if (b) out.push({ moduleId: a.moduleId, source: a.modname === 'scorm' ? 'scorm' : 'libro', questionId: null, text: plainText(b.toString('utf8'), MAX) });
      }
    }
    if (a.exam) {
      for (const q of a.exam.questions) out.push({ moduleId: a.moduleId, source: 'question', questionId: q.id, text: [q.html, ...q.answers.map((x) => x.html)].map((h) => plainText(h, 2000)).join('\n') });
    }
  }
  return out;
}
