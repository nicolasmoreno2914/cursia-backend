/**
 * Edu EV2 — estructura educativa mínima de un capítulo NUEVO.
 *
 * Decisión de producto (2026-09-29): ningún capítulo puede ser «título grande + párrafos».
 * Cada experiencia generada debe recorrer: introducción visual → conceptos clave →
 * explicación → ejemplo práctico → recurso visual (la actividad y la evaluación las pone
 * el curso). Estas reglas se aplican SOLO al aceptar una experiencia recién generada
 * (validación del item v3); NUNCA al empaquetar: los cursos ya generados siguen siendo
 * válidos con el schema R2 (validateExperience / assertValidExperience no cambian).
 */
import type { ChapterExperience, VcComponentType } from './schema';
import type { VcValidationError } from './validate';

export const VC_PEDAGOGY = {
  /** La apertura empieza con una introducción visual. */
  visualIntro: ['hero'] as readonly VcComponentType[],
  /** Conceptos clave (apertura o profundización). */
  keyConcepts: ['concept_cards'] as readonly VcComponentType[],
  /** Ejemplo práctico (profundización o cierre). */
  example: ['worked_example', 'case_scenario'] as readonly VcComponentType[],
  /** Recurso visual en la profundización. */
  visual: ['diagram', 'comparison', 'process_steps', 'timeline'] as readonly VcComponentType[],
  /** Máximo de caracteres por bloque de explicación (evita muros de texto). */
  denseMax: 600,
};

type Doc = Pick<ChapterExperience, 'movements'>;

function typesIn(doc: Doc, movements: Array<keyof ChapterExperience['movements']>): string[] {
  const out: string[] = [];
  for (const m of movements) {
    const list = doc.movements?.[m];
    if (Array.isArray(list)) for (const c of list) if (c && typeof c === 'object' && typeof (c as { type?: unknown }).type === 'string') out.push((c as { type: string }).type);
  }
  return out;
}

const hasAny = (types: string[], wanted: readonly string[]) => types.some((t) => wanted.includes(t));

/**
 * Errores PEDAGOGY_MISSING / TEXT_DENSE (vacío = cumple). Espera un documento que ya pasó
 * validateExperience (no re-valida el schema).
 */
export function validatePedagogy(doc: Doc): VcValidationError[] {
  const errors: VcValidationError[] = [];
  if (!doc || typeof doc !== 'object' || !doc.movements) return errors;
  const opening = doc.movements.opening;
  const first = Array.isArray(opening) && opening[0] ? (opening[0] as { type?: string }).type : undefined;
  if (!first || !VC_PEDAGOGY.visualIntro.includes(first as VcComponentType)) {
    errors.push({ path: '$.movements.opening[0]', code: 'PEDAGOGY_MISSING', message: 'la apertura debe empezar con una introducción visual ("hero")' });
  }
  if (!hasAny(typesIn(doc, ['opening', 'deepening']), VC_PEDAGOGY.keyConcepts)) {
    errors.push({ path: '$.movements.deepening', code: 'PEDAGOGY_MISSING', message: 'faltan los conceptos clave: agrega un "concept_cards" en opening o deepening' });
  }
  if (!hasAny(typesIn(doc, ['deepening', 'closing']), VC_PEDAGOGY.example)) {
    errors.push({ path: '$.movements.deepening', code: 'PEDAGOGY_MISSING', message: 'falta un ejemplo práctico: agrega un "worked_example" (o un "case_scenario") en deepening' });
  }
  if (!hasAny(typesIn(doc, ['deepening']), VC_PEDAGOGY.visual)) {
    errors.push({ path: '$.movements.deepening', code: 'PEDAGOGY_MISSING', message: 'falta un recurso visual en deepening: agrega un "diagram", "comparison", "process_steps" o "timeline"' });
  }
  for (const m of ['opening', 'deepening', 'synthesis', 'closing', 'video_primer'] as const) {
    const list = doc.movements[m];
    if (!Array.isArray(list)) continue;
    list.forEach((c, i) => {
      const comp = c as { type?: string; items?: Array<{ body?: unknown }>; tabs?: Array<{ body?: unknown }> };
      const parts = comp.type === 'accordion' ? comp.items : comp.type === 'tabs' ? comp.tabs : undefined;
      const key = comp.type === 'accordion' ? 'items' : 'tabs';
      (Array.isArray(parts) ? parts : []).forEach((p, j) => {
        const len = typeof p?.body === 'string' ? Array.from(p.body).length : 0;
        if (len > VC_PEDAGOGY.denseMax) {
          errors.push({ path: `$.movements.${m}[${i}].${key}[${j}].body`, code: 'TEXT_DENSE', message: `${len} caracteres: un bloque de explicación lleva como máximo ${VC_PEDAGOGY.denseMax} (2–3 frases); divide la idea o pásala a un recurso visual` });
        }
      });
    });
  }
  return errors;
}
