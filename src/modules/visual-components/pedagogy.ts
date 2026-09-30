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
import { VC_MOVEMENT_IDS } from './schema';
import type { ChapterExperience, VcComponentType } from './schema';
import type { VcValidationError } from './validate';
import { lintView } from './text';

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
    errors.push({ path: '$.movements.deepening', code: 'PEDAGOGY_MISSING', message: 'faltan los conceptos clave: agrega un "concept_cards" en opening o deepening (o reemplaza un componente de menor prioridad: deepening admite hasta 5)' });
  }
  if (!hasAny(typesIn(doc, ['deepening', 'closing']), VC_PEDAGOGY.example)) {
    errors.push({ path: '$.movements.deepening', code: 'PEDAGOGY_MISSING', message: 'falta un ejemplo práctico: agrega un "worked_example" (o un "case_scenario") en deepening (o reemplaza un componente de menor prioridad: deepening admite hasta 5)' });
  }
  if (!hasAny(typesIn(doc, ['deepening']), VC_PEDAGOGY.visual)) {
    errors.push({ path: '$.movements.deepening', code: 'PEDAGOGY_MISSING', message: 'falta un recurso visual en deepening: agrega un "diagram", "comparison", "process_steps" o "timeline" (o reemplaza un componente de menor prioridad: deepening admite hasta 5)' });
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

// ─── EV6 — diagramas simulados con texto ────────────────────────────────────
//
// Auditoría #413 (primeros auxilios): un árbol de decisión llegó como flujo lineal
// «1 ¿Responde? → 2 Sí → Consciente → 3 No → …», enseñando una secuencia que no existe.
// Igual que validatePedagogy, se aplica SOLO al aceptar una experiencia nueva (nunca al empaquetar).

/** Flechas que dibujan un diagrama dentro del texto. */
const ARROW_RE = /→|->|⇒/g;
/** Mínimo de flechas en UN párrafo para considerarlo un diagrama simulado («A → B → C»). */
export const VC_ARROW_CHAIN_MIN = 2;

/**
 * Encabezado de paso que codifica una rama (texto normalizado: minúsculas, sin acentos):
 * «Sí → Consciente», «No: llama al 123», «Si - …», «Si no responde…», «En caso contrario…».
 * «Sistema…», «Nota: …», «No-conformidad» no coinciden.
 */
const BRANCH_HEAD_RE = /^(?:(?:si|no)\s*(?:→|->|⇒|[:\-–—](?=\s|$))|si\s+no(?![\p{L}\p{N}_])|en\s+caso\s+contrario(?![\p{L}\p{N}_])|de\s+lo\s+contrario(?![\p{L}\p{N}_]))/u;

function foldLint(text: string): string {
  return lintView(String(text ?? '')).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Nº máximo de flechas en un mismo párrafo del texto. */
export function arrowChainLength(text: string): number {
  let best = 0;
  for (const para of String(text ?? '').split(/\r?\n[ \t]*\r?\n/)) {
    const n = (para.match(ARROW_RE) || []).length;
    if (n > best) best = n;
  }
  return best;
}

/** ¿El rótulo/encabezado de un paso codifica una rama (Sí/No/Si no/En caso contrario)? */
export function isBranchHead(text: string): boolean {
  return BRANCH_HEAD_RE.test(foldLint(text));
}

/** Rótulos de ítems de secuencia por tipo: [lista, campo]. */
function sequenceHeads(c: Record<string, unknown>): { list: string; field: string } | null {
  if (c.type === 'diagram' && (c.kind === 'flow' || c.kind === 'cycle')) return { list: 'nodes', field: 'label' };
  if (c.type === 'process_steps') return { list: 'steps', field: 'heading' };
  if (c.type === 'timeline') return { list: 'events', field: 'heading' };
  return null;
}

const SKIP_KEYS = new Set(['type', 'kind', 'variant']);

function walkTexts(v: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof v === 'string') out.push({ path, text: v });
  else if (Array.isArray(v)) v.forEach((x, i) => walkTexts(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!SKIP_KEYS.has(k)) walkTexts(x, `${path}.${k}`, out);
}

/**
 * Errores DIAGRAM_BRANCHING_IN_SEQUENCE / TEXT_SIMULATED_DIAGRAM (vacío = cumple). Espera un
 * documento que ya pasó validateExperience. Solo textos del LLM (el shell escribe los suyos aparte).
 */
export function validateSimulatedDiagrams(doc: Pick<ChapterExperience, 'movements'> & { bridge_to_next?: unknown }): VcValidationError[] {
  const errors: VcValidationError[] = [];
  if (!doc || typeof doc !== 'object' || !doc.movements) return errors;
  for (const m of VC_MOVEMENT_IDS) {
    const list = doc.movements[m];
    if (!Array.isArray(list)) continue;
    list.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const c = raw as unknown as Record<string, unknown>;
      const cpath = `$.movements.${m}[${i}]`;
      const seq = sequenceHeads(c);
      const items = seq ? c[seq.list] : undefined;
      if (seq && Array.isArray(items)) {
        items.forEach((it, j) => {
          const head = it && typeof it === 'object' ? (it as Record<string, unknown>)[seq.field] : undefined;
          if (typeof head === 'string' && isBranchHead(head)) {
            errors.push({
              path: `${cpath}.${seq.list}[${j}].${seq.field}`,
              code: 'DIAGRAM_BRANCHING_IN_SEQUENCE',
              message: 'este paso codifica una rama («Sí → …», «No: …», «Si no…»): una secuencia no se ramifica; si hay condiciones usa un diagram con kind "decision"',
            });
          }
        });
      }
      const texts: Array<{ path: string; text: string }> = [];
      walkTexts(c, cpath, texts);
      for (const t of texts) {
        if (arrowChainLength(t.text) >= VC_ARROW_CHAIN_MIN) {
          errors.push({ path: t.path, code: 'TEXT_SIMULATED_DIAGRAM', message: 'el texto dibuja un diagrama con flechas («A → B → C»): escribe frases o usa process_steps o un diagram' });
        }
      }
    });
  }
  if (typeof doc.bridge_to_next === 'string' && arrowChainLength(doc.bridge_to_next) >= VC_ARROW_CHAIN_MIN) {
    errors.push({ path: '$.bridge_to_next', code: 'TEXT_SIMULATED_DIAGRAM', message: 'el texto dibuja un diagrama con flechas («A → B → C»): escribe frases o usa process_steps o un diagram' });
  }
  return errors;
}
