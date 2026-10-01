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
import { VC_EDU_APPLY_TYPES, VC_EDU_WHY_TYPES, VC_MOVEMENT_IDS } from './schema';
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
 * Encabezado de paso que codifica una rama (texto normalizado: minúsculas, sin acentos, sin comillas
 * ni numeración inicial «2 », «3. », «4) »). Dos fuerzas (fix round 2):
 *  - FUERTE (marca solo): «Sí» / «No» solos (o con punto); «Sí» / «No» + flecha; «Si no…», «En caso
 *    contrario…», «De lo contrario…»; una condición corta que termina en flecha: «Si responde → …».
 *  - DÉBIL (fix round 3): «Sí» / «No» + «,» «;» «(» o «:» / «-» / «–» / «—» + espacio, y una condición
 *    corta con dos puntos («Si respira: …»). También son advertencias o confirmaciones normales
 *    («No, nunca la muevas», «Sí - revisa el manómetro cada hora», «No: pero primero verifica»): cuentan
 *    SOLO si la misma secuencia tiene otro encabezado de la polaridad opuesta, o si siguen
 *    inmediatamente a una pregunta «¿…?».
 * No coinciden: «Sistema…», «Nota: …», «No-conformidad», «No olvides…» (imperativo normal),
 * «Si el equipo vibra, detén la línea» (paso con condición, sin flecha ni dos puntos).
 */
const WORD_END = '(?![\\p{L}\\p{N}_])';
/** Condición corta: 1–4 palabras sin puntuación de corte. */
const SHORT_CLAUSE = '[^\\s,;:→]+(?:\\s+[^\\s,;:→]+){0,3}';
const STRONG_HEAD_RE = new RegExp(
  '^(?:' +
    [
      '(?:si|no)[.!]?$',
      '(?:si|no)\\s*(?:→|->|⇒)',
      `si\\s+no${WORD_END}`,
      `en\\s+caso\\s+contrario${WORD_END}`,
      `de\\s+lo\\s+contrario${WORD_END}`,
      `si\\s+${SHORT_CLAUSE}\\s*(?:→|->|⇒)`,
    ].join('|') +
    ')',
  'u',
);
const WEAK_HEAD_RE = new RegExp(`^(?:(?:si|no)\\s*(?:[,;(]|[:\\-–—](?=\\s|$))|si\\s+${SHORT_CLAUSE}\\s*:)`, 'u');
/** Polaridad de la rama: «no» para «No…», «Si no…», «En caso contrario…», «De lo contrario…». */
const NEGATIVE_HEAD_RE = new RegExp(`^(?:no${WORD_END}|si\\s+no${WORD_END}|en\\s+caso\\s+contrario|de\\s+lo\\s+contrario)`, 'u');

export interface VcBranchHead {
  strength: 'strong' | 'weak';
  polarity: 'yes' | 'no';
}

/** Numeración y comillas iniciales («2 Sí → …», «"Sí" → …») no esconden la rama. */
const QUOTES_RE = /["'«»“”‘’„]/g;
const LEAD_NUM_RE = /^\s*\d{1,2}\s*[.)\-–:]?\s+/;
/** Encabezado que es una pregunta («¿Responde?»): en una secuencia, anuncia ramas. */
const QUESTION_HEAD_RE = /^¿.*\?$/su;

function foldLint(text: string): string {
  return lintView(String(text ?? '')).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function headView(text: string): string {
  return foldLint(text).replace(QUOTES_RE, '').replace(LEAD_NUM_RE, '').trim();
}

/** Nº máximo de flechas en una misma LÍNEA del texto («A → B\nC → D» son dos pares, no una cadena). */
export function arrowChainLength(text: string): number {
  let best = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const n = (line.match(ARROW_RE) || []).length;
    if (n > best) best = n;
  }
  return best;
}

/** Clasifica un encabezado: rama FUERTE, DÉBIL (depende de la secuencia) o null. */
export function branchHead(text: string): VcBranchHead | null {
  const h = headView(text);
  const strength = STRONG_HEAD_RE.test(h) ? 'strong' : WEAK_HEAD_RE.test(h) ? 'weak' : null;
  return strength ? { strength, polarity: NEGATIVE_HEAD_RE.test(h) ? 'no' : 'yes' } : null;
}

/** ¿El encabezado codifica una rama por sí solo (FUERTE)? Los DÉBILES dependen de la secuencia. */
export function isBranchHead(text: string): boolean {
  return branchHead(text)?.strength === 'strong';
}

/**
 * Índices de los encabezados que codifican ramas en UNA secuencia: los FUERTES; los DÉBILES con otro
 * encabezado de polaridad opuesta en la misma secuencia o justo después de una pregunta.
 */
export function branchingHeadIndexes(heads: string[]): number[] {
  const kinds = heads.map((h) => (h ? branchHead(h) : null));
  const isQ = heads.map((h) => !!h && isQuestionHead(h));
  const out: number[] = [];
  kinds.forEach((k, j) => {
    if (!k) return;
    if (k.strength === 'strong') out.push(j);
    else if ((j > 0 && isQ[j - 1]) || kinds.some((o, i) => i !== j && !!o && o.polarity !== k.polarity)) out.push(j);
  });
  return out;
}

/** ¿El rótulo es una pregunta («¿…?»)? */
export function isQuestionHead(text: string): boolean {
  return QUESTION_HEAD_RE.test(headView(text));
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
        const heads = items.map((it) => {
          const h = it && typeof it === 'object' ? (it as Record<string, unknown>)[seq.field] : undefined;
          return typeof h === 'string' ? h : '';
        });
        const flagged = new Set(branchingHeadIndexes(heads));
        const branchAt = heads.map((_h, j) => flagged.has(j));
        heads.forEach((h, j) => {
          if (branchAt[j]) {
            errors.push({
              path: `${cpath}.${seq.list}[${j}].${seq.field}`,
              code: 'DIAGRAM_BRANCHING_IN_SEQUENCE',
              message: 'este paso codifica una rama («Sí → …», «No: …», «Si no…»): una secuencia no se ramifica; si hay condiciones usa un diagram con kind "decision"',
            });
          } else if (h && isQuestionHead(h) && branchAt.some((x, k) => x && k > j)) {
            // Señal estructural: una pregunta seguida de pasos-rama es un árbol aplanado (auditoría #413).
            errors.push({
              path: `${cpath}.${seq.list}[${j}].${seq.field}`,
              code: 'DIAGRAM_BRANCHING_IN_SEQUENCE',
              message: 'una pregunta seguida de pasos «Sí/No» es un árbol de decisión aplanado: usa un diagram con kind "decision" (la pregunta es "question" y cada respuesta, una rama)',
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

// ─── P3 — «¿Por qué importa?» / «¿Cómo lo aplicas?» ─────────────────────────

/** Mínimo de bloques con `why` y con `apply` en una experiencia NUEVA (≥ v21-exp-6); tope del prompt: 6. */
export const VC_EDU_FIELDS_MIN = 2;

/** Tipos «de texto» (sin estructura visual propia): una racha de ellos es lo que el estudiante lee seguido. */
export const VC_TEXT_RUN_TYPES: readonly VcComponentType[] = ['accordion', 'tabs', 'callout', 'case_scenario', 'reflection'];
/** Recomendación del sistema visual 2.0: ~250 palabras como máximo entre elementos visuales (métrica, no error). */
export const VC_TEXT_RUN_TARGET_WORDS = 250;

function componentsOf(doc: Doc): Array<{ m: string; i: number; c: Record<string, unknown> }> {
  const out: Array<{ m: string; i: number; c: Record<string, unknown> }> = [];
  for (const m of VC_MOVEMENT_IDS) {
    const list = doc?.movements?.[m];
    if (Array.isArray(list)) list.forEach((c, i) => { if (c && typeof c === 'object') out.push({ m, i, c: c as unknown as Record<string, unknown> }); });
  }
  return out;
}

const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

/**
 * EDU_FIELDS_MISSING si la experiencia trae menos de VC_EDU_FIELDS_MIN bloques con `why` o con `apply`
 * (o menos que los bloques que los admiten, si hay pocos). Solo experiencias NUEVAS (el empaque nunca
 * lo exige: las viejas se dibujan sin esas líneas).
 */
export function validateEduFields(doc: Doc): VcValidationError[] {
  const all = componentsOf(doc);
  const whyOk = all.filter((x) => VC_EDU_WHY_TYPES.includes(x.c.type as VcComponentType));
  const applyOk = all.filter((x) => VC_EDU_APPLY_TYPES.includes(x.c.type as VcComponentType));
  const errors: VcValidationError[] = [];
  const needWhy = Math.min(VC_EDU_FIELDS_MIN, whyOk.length);
  const needApply = Math.min(VC_EDU_FIELDS_MIN, applyOk.length);
  const haveWhy = whyOk.filter((x) => filled(x.c.why)).length;
  const haveApply = applyOk.filter((x) => filled(x.c.apply)).length;
  if (haveWhy < needWhy) errors.push({ path: '$.movements', code: 'EDU_FIELDS_MISSING', message: `${haveWhy} bloque(s) con "why": agrega "why" (por qué le importa al estudiante, una frase) en al menos ${needWhy} bloques de contenido (${VC_EDU_WHY_TYPES.join(', ')})` });
  if (haveApply < needApply) errors.push({ path: '$.movements', code: 'EDU_FIELDS_MISSING', message: `${haveApply} bloque(s) con "apply": agrega "apply" (una acción concreta en su trabajo, una frase) en al menos ${needApply} bloques de contenido` });
  return errors;
}

/** Métricas P3 para el output_summary: bloques con why/apply y la racha de texto más larga (palabras). */
export function eduMetrics(doc: Doc): { why: number; apply: number; longestTextRunWords: number } {
  const all = componentsOf(doc);
  let longest = 0;
  for (const m of VC_MOVEMENT_IDS) {
    let run = 0;
    for (const x of all.filter((y) => y.m === m)) {
      if (VC_TEXT_RUN_TYPES.includes(x.c.type as VcComponentType)) {
        run += wordsOf(x.c);
        longest = Math.max(longest, run);
      } else run = 0;
    }
  }
  return { why: all.filter((x) => filled(x.c.why)).length, apply: all.filter((x) => filled(x.c.apply)).length, longestTextRunWords: longest };
}

function wordsOf(v: unknown, key?: string): number {
  if (typeof v === 'string') return key === 'type' || key === 'variant' ? 0 : lintView(v).split(/\s+/).filter(Boolean).length;
  if (Array.isArray(v)) return v.reduce((a: number, x) => a + wordsOf(x), 0);
  if (v && typeof v === 'object') return Object.entries(v).reduce((a, [k, x]) => a + wordsOf(x, k), 0);
  return 0;
}
