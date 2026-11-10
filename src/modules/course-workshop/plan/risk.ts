/**
 * r107 B5 · Riesgo de un ítem del plan — regla EXPLÍCITA (D5), la más alta que aplique:
 *
 *   ALTO   · quitar una actividad (el contenido sale del curso; volver atrás = descargar la versión anterior)
 *          · recomponer un Libro Guía cortado (se reescribe el documento entero)
 *          · agregar capítulo o módulo (fase posterior: estructura nueva)
 *   MEDIO  · editar capítulos del Libro Guía (se reemplaza el archivo del Libro)
 *          · quitar una pregunta de examen (cambia la nota máxima del examen)
 *          · reescribir (edit_html) un campo que tiene enlaces internos ($@…@$) o archivos (@@PLUGINFILE@@)
 *          · reescribir (edit_html) más de la mitad del texto del campo
 *          · regenerar juego / video / Gamma / audio (fase posterior: el contenido cambia entero)
 *          · cualquier ítem con avisos de desalineación (D7): queda algo del curso diciendo otra cosa
 *   BAJO   · lo demás: corregir texto puntual sin enlaces, reemplazar / agregar una pregunta, colores de la marca,
 *            quitar o corregir un enlace roto (arreglo de un hallazgo)
 *
 * Puro.
 */
import { plainText } from '../course-model';
import type { FieldChange, PatchOperation } from '../patch/types';
import type { MisalignmentWarning, PlanRisk, RequestOperation, RiskLevel, ResolvedTarget } from './types';

const RANK: Record<RiskLevel, number> = { bajo: 0, medio: 1, alto: 2 };

/** Proporción del texto que cambia (distancia por palabras, aproximada y barata). */
export function changedShare(before: string, after: string): number {
  const a = plainText(before, 100_000).split(/\s+/).filter(Boolean);
  const b = plainText(after, 100_000).split(/\s+/).filter(Boolean);
  if (!a.length) return b.length ? 1 : 0;
  const bag = new Map<string, number>();
  for (const w of b) bag.set(w, (bag.get(w) ?? 0) + 1);
  let kept = 0;
  for (const w of a) { const n = bag.get(w) ?? 0; if (n > 0) { kept++; bag.set(w, n - 1); } }
  return 1 - kept / Math.max(a.length, b.length);
}

export function riskOf(input: { operation: RequestOperation; target: ResolvedTarget | null; changes: FieldChange[]; misalignment: MisalignmentWarning[]; fromFinding: boolean; params?: PatchOperation | null }): PlanRisk {
  const reasons: Array<[RiskLevel, string]> = [];
  const op = input.operation;
  if (op === 'remove_activity') reasons.push(['alto', 'Quita una actividad del curso (volver atrás = descargar la versión anterior).']);
  if (op === 'edit_libro_section' && input.target?.kind === 'libro' && input.target.recompose) reasons.push(['alto', 'Recompone el Libro Guía completo (estaba cortado).']);
  if (op === 'add_chapter' || op === 'add_module') reasons.push(['alto', 'Agrega estructura nueva al curso.']);
  if (op === 'edit_libro_section' && !(input.target?.kind === 'libro' && input.target.recompose)) reasons.push(['medio', 'Reemplaza el archivo del Libro Guía.']);
  if (op === 'exam_question_remove') reasons.push(['medio', 'Cambia la cantidad de preguntas del examen (y su nota máxima).']);
  if (op.startsWith('regenerate_')) reasons.push(['medio', 'Rehace la actividad entera (fase posterior).']);
  // Solo cuando se REESCRIBE el contenido del campo (edit_html); un cambio de colores o un enlace quitado no lo toca.
  const rewrite = op === 'edit_html' && !!input.params && input.params.op === 'edit_html' && input.params.change.kind === 'replace';
  if (rewrite) {
    for (const c of input.changes) {
      if (/\$@[A-Z0-9_]+/.test(c.before) || /@@PLUGINFILE@@/.test(c.before)) { reasons.push(['medio', 'El campo tiene enlaces internos o archivos (se conservan, pero conviene revisarlo).']); break; }
    }
    for (const c of input.changes) {
      if (changedShare(c.before, c.after) > 0.5) { reasons.push(['medio', 'El cambio reescribe más de la mitad del texto.']); break; }
    }
  }
  if (input.misalignment.length) reasons.push(['medio', `Hay ${input.misalignment.length} aviso(s) de desalineación: otras partes del curso pueden quedar diciendo otra cosa.`]);
  if (!reasons.length) reasons.push(['bajo', input.fromFinding ? 'Arreglo puntual de un hallazgo del diagnóstico.' : 'Cambio puntual de contenido.']);
  const level = reasons.reduce<RiskLevel>((m, [l]) => (RANK[l] > RANK[m] ? l : m), 'bajo');
  return { level, reasons: reasons.map(([, r]) => r) };
}
