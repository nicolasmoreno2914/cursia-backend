/**
 * r107 B5 · «Arreglar esto»: un hallazgo del diagnóstico B3 → pedido estructurado, DIRECTO desde su `suggestedFix` (ya
 * probado en seco por B4: `fixPrecheck` ok / fallback), SIN interpretación de IA. Si el arreglo necesita contenido nuevo
 * (reescribir una etiqueta vacía o con «⚠️ Pendiente», corregir una pregunta, recomponer el Libro cortado) lo genera el
 * armado del plan como cualquier otro pedido (content.ts / builder.ts).
 *
 * Puro.
 */
import type { Finding } from '../diagnosis/finding';
import { WorkshopCourse } from '../course-model';
import { RawAiRequest, resolveRequest } from './interpret';
import { activityOf, editableField } from './summary';
import { InterpretedRequest, LATER_OPERATIONS, RequestOperation } from './types';
import { isRegenOperation } from '../regenerate/types';

// r107 B10: las regeneraciones (Fase 3) se resuelven igual que las de fase posterior: destino desde el hallazgo, sin IA.
const isLater = (op: string) => (LATER_OPERATIONS as readonly string[]).includes(op) || isRegenOperation(op);

export function requestFromFinding(f: Finding, course: WorkshopCourse): InterpretedRequest {
  const fx = f.suggestedFix;
  // r107 B8 (revisión P2-2): la sugerencia de una revisión de IA es texto NO verificado: viaja solo dentro de la cita del
  // pedido (que el prompt de contenido de B5 pone como dato no confiable), nunca como la instrucción.
  const aiSug = typeof (fx?.params as any)?.aiSuggestion === 'string' && (fx!.params as any).aiSuggestion.trim() ? String((fx!.params as any).aiSuggestion).trim().slice(0, 600) : null;
  const quote = aiSug ? `${f.title} — sugerencia de la IA (no verificada): «${aiSug}»` : f.title;
  const blank = (over: Partial<InterpretedRequest>): InterpretedRequest => ({
    quote, instruction: `Arreglar: ${f.title}`, operation: null, status: 'unavailable', target: null, rawTarget: null, details: { findingId: f.id }, questions: [], reason: null, ...over,
  });
  if (!fx) {
    return blank({ reason: f.fixPrecheck?.reason ? `No hay un arreglo automático para este hallazgo: ${f.fixPrecheck.reason}.` : 'No hay un arreglo automático para este hallazgo (hay que corregirlo en el curso de origen o regenerarlo).' });
  }
  const p = fx.params as Record<string, any>;
  const op = fx.operation as RequestOperation;
  const fallbackNote = f.fixPrecheck?.status === 'fallback' && f.fixPrecheck.reason ? ` (${f.fixPrecheck.reason})` : '';
  // r107 B8: los hallazgos de CALIDAD traen su instrucción concreta en los parámetros (qué cambiar, con la cita).
  const given = typeof p.instruction === 'string' && p.instruction.trim() ? p.instruction.trim().slice(0, 1000) : null;
  const viaResolve = (raw: Partial<RawAiRequest>): InterpretedRequest => {
    const r = resolveRequest({ quote, operation: op as RawAiRequest['operation'], instruction: raw.instruction ?? `Arreglar: ${f.title}`, target: raw.target ?? null, colors: [], chapters: null, reason: null, questions: [] }, course, { trustedTarget: true, trustedChange: true });
    return { ...r, details: { ...r.details, findingId: f.id } };
  };

  if (isLater(op)) {
    return viaResolve({ target: { ...(typeof (p.moduleId ?? p.labelModuleId) === 'number' ? { moduleId: p.moduleId ?? p.labelModuleId } : {}), ...(typeof p.chapterNumber === 'number' ? { chapterNumber: p.chapterNumber } : {}) } });
  }

  switch (op) {
    case 'remove_activity':
      return viaResolve({ target: { moduleId: p.moduleId } });
    case 'exam_question_replace':
      return viaResolve({ target: { quizModuleId: p.quizModuleId, questionId: p.questionId }, instruction: given ?? `Corregir la pregunta para que cumpla las reglas del banco (exactamente una respuesta correcta, opciones distintas): ${f.title}` });
    case 'exam_question_remove':
      return viaResolve({ target: { quizModuleId: p.quizModuleId, questionId: p.questionId } });
    case 'exam_question_add':
      return viaResolve({ target: { quizModuleId: p.quizModuleId }, instruction: given ?? `Escribir una pregunta de opción múltiple para este examen, sobre los capítulos que evalúa: ${f.title}` });
    case 'edit_libro_section': {
      const a = activityOf(course, p.moduleId);
      if (!a) return blank({ reason: 'El Libro Guía ya no está en el paquete.' });
      const fmt = course.libro.find((l) => l.moduleId === a.moduleId)?.format;
      if (fmt === 'pdf') return blank({ reason: 'El Libro Guía es un PDF: regenerarlo exige su fuente por capítulo (llega con la aplicación de arreglos, B6).' });
      const chapters: number[] = Array.isArray(p.chapters) ? p.chapters.filter((n: unknown) => Number.isInteger(n)) : [];
      return {
        quote, operation: 'edit_libro_section', status: 'resolved',
        instruction: given ?? (p.section === 'all' ? 'Recomponer el Libro Guía: escribir completos los capítulos que se perdieron, con el mismo estilo que los que quedaron.' : `Escribir los capítulos que faltan en el Libro Guía (${chapters.join(', ')}).`),
        target: { kind: 'libro', moduleId: a.moduleId, chapters, title: a.title, recompose: p.section === 'all' },
        rawTarget: { moduleId: a.moduleId, chapters }, details: { findingId: f.id }, questions: [], reason: null,
      };
    }
    case 'edit_html': {
      const a = typeof p.moduleId === 'number' ? activityOf(course, p.moduleId) : null;
      const sectionId = typeof p.sectionId === 'number' ? p.sectionId : null;
      if (!a && sectionId === null) return blank({ reason: 'La actividad del hallazgo ya no está en el paquete.' });
      const field = a ? (editableField(a, p.field) ?? p.field) : 'summary';
      const chapterNumber = a && a.placement.scope === 'chapter' ? a.placement.chapterNumber : null;
      const target = { kind: 'html' as const, moduleId: a ? a.moduleId : null, sectionId, field, title: a ? a.title : 'Presentación de una sección', chapterNumber };
      const base: InterpretedRequest = { quote, operation: 'edit_html', status: 'resolved', instruction: given ? `${given}${fallbackNote}` : `Arreglar: ${f.title}${fallbackNote}`, target, rawTarget: { moduleId: a?.moduleId, field }, details: { findingId: f.id }, questions: [], reason: null };
      if (typeof p.token === 'string' && p.token) {
        if (typeof p.replaceWith === 'string' && p.replaceWith) return { ...base, details: { ...base.details, fixedChange: { kind: 'token', token: p.token, action: 'retarget', to: p.replaceWith } } };
        if (p.mode !== 'replace') return { ...base, details: { ...base.details, fixedChange: { kind: 'token', token: p.token, action: 'unlink' } } };
        return { ...base, instruction: `Quitar el enlace roto (${p.token}) conservando el texto y el resto del contenido igual${p.reason ? ` — ${p.reason}` : ''}.`, details: { ...base.details, forbiddenTokens: [p.token] } };
      }
      if (Number.isInteger(p.linkRawByteOffset) && Number.isInteger(p.linkRawBytes) && typeof p.entry === 'string' && Number.isInteger(p.fieldRawOffset)) {
        return { ...base, details: { ...base.details, expectRawSha1: typeof p.fieldRawSha1 === 'string' ? p.fieldRawSha1 : null, deadLink: { entry: p.entry, fieldRawOffset: p.fieldRawOffset, rawByteOffset: p.linkRawByteOffset, rawBytes: p.linkRawBytes } } };
      }
      if (typeof p.relinkAudio === 'string') return { ...base, instruction: `Volver a enlazar el reproductor de audio al archivo «${p.relinkAudio}» (src="@@PLUGINFILE@@/${p.relinkAudio}") sin cambiar el resto.`, details: { ...base.details, allowFiles: [p.relinkAudio] } };
      if (f.code === 'pending_activity' || f.code === 'pending_mark' || /Pendiente/.test(f.title)) return { ...base, instruction: `Reemplazar el aviso «⚠️ Pendiente» por el contenido que corresponde a esta actividad (con el estilo del resto del curso)${fallbackNote}.` };
      if (f.code === 'empty_activity') return { ...base, instruction: `Escribir el contenido de esta actividad, que está vacía, de acuerdo con su título y su capítulo${fallbackNote}.` };
      return base;
    }
    default:
      return blank({ reason: `La operación «${op}» no está disponible en esta fase.` });
  }
}
