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

// ─── Fix round 1 (P2-4): guarda de cambios masivos / de riesgo alto ─────────

/** Más de este número de ítems de riesgo alto en un plan → aviso del plan. */
export const HIGH_RISK_PLAN_THRESHOLD = 5;
/** Más de este número de `remove_activity` salidos de UNA misma entrada → aviso de cambio masivo. */
export const BULK_REMOVALS_PER_INTAKE = 3;

/** Todo ítem de riesgo ALTO exige que el docente lo confirme uno por uno al aplicar (B6). */
export const requiresItemConfirm = (risk: PlanRisk): boolean => risk.level === 'alto';

export interface PlanWarning { code: 'REMOVALS' | 'BULK_REMOVALS' | 'MANY_HIGH_RISK'; message: string; count: number; itemIds: string[] }

/** Avisos del PLAN (no de un ítem): quitar actividades, cambios masivos desde una misma entrada, muchos de riesgo alto. */
export function planWarnings(items: Array<{ id: string; operation: string; risk: PlanRisk; intakeId: string | null; live: boolean }>): PlanWarning[] {
  const live = items.filter((i) => i.live);
  const out: PlanWarning[] = [];
  const removes = live.filter((i) => i.operation === 'remove_activity');
  if (removes.length) out.push({ code: 'REMOVALS', count: removes.length, itemIds: removes.map((i) => i.id), message: `El plan QUITA ${removes.length} actividad(es) del curso: cada una se confirma por separado al aplicar.` });
  const byIntake = new Map<string, string[]>();
  for (const r of removes) if (r.intakeId) byIntake.set(r.intakeId, [...(byIntake.get(r.intakeId) ?? []), r.id]);
  for (const [, ids] of byIntake) {
    if (ids.length > BULK_REMOVALS_PER_INTAKE) out.push({ code: 'BULK_REMOVALS', count: ids.length, itemIds: ids, message: `Un mismo pedido quita ${ids.length} actividades: revisa que de verdad lo quieras (un documento puede pedir de más).` });
  }
  const high = live.filter((i) => i.risk.level === 'alto');
  if (high.length > HIGH_RISK_PLAN_THRESHOLD) out.push({ code: 'MANY_HIGH_RISK', count: high.length, itemIds: high.map((i) => i.id), message: `El plan tiene ${high.length} cambios de riesgo alto: revísalos uno por uno.` });
  return out;
}
