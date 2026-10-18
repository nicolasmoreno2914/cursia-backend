/**
 * T1 (r57) — lint de CURSO (determinístico, sin IA): fórmulas de apertura que se repiten entre capítulos.
 *
 * En un curso real de 15 capítulos: «Ya sabes… Ahora viene…» abría 9 de 15 capítulos y «Piensa en…» 11 de 15
 * cierres. Cada texto aislado es correcto (ningún validador por capítulo lo ve); el problema es la REPETICIÓN entre
 * capítulos. Este lint mide, por ranura (gancho de apertura, reflexión, puente, why/apply), cuántos capítulos abren con
 * las mismas dos palabras y lo informa como AVISO DE CALIDAD del paquete (nunca falla el empaque: la redacción ya
 * está pagada; el prompt pide variedad y este aviso lo hace visible).
 */

export interface FormulaicOpeningFinding {
  /** Ranura: hero_lead | reflection | bridge | why | apply. */
  slot: string;
  /** Dos primeras palabras normalizadas (minúsculas, sin tildes ni puntuación). */
  opening: string;
  /** Capítulos que usan esa apertura en la ranura. */
  chapters: number;
  /** Capítulos que tienen la ranura. */
  total: number;
}

/** Umbral: ≥ 3 capítulos y ≥ 40 % de los que tienen la ranura. */
export const FORMULAIC_MIN_CHAPTERS = 3;
export const FORMULAIC_MIN_SHARE = 0.4;

const norm = (s: string): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');

type Comp = Record<string, unknown> & { type?: unknown };

function slotsOf(exp: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (slot: string, text: unknown) => {
    if (typeof text !== 'string') return;
    const k = norm(text);
    if (k.split(' ').length < 2) return;
    if (!out.has(slot)) out.set(slot, new Set());
    (out.get(slot) as Set<string>).add(k);
  };
  const e = (exp ?? {}) as { movements?: Record<string, Comp[]>; bridge_to_next?: unknown };
  const mv = e.movements ?? {};
  const opening = Array.isArray(mv.opening) ? mv.opening : [];
  const hero = opening.find((c) => c && c.type === 'hero');
  if (hero) add('hero_lead', hero.lead);
  for (const list of Object.values(mv)) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'reflection') add('reflection', c.prompt);
      add('why', c.why);
      add('apply', c.apply);
    }
  }
  add('bridge', e.bridge_to_next);
  return out;
}

/** Hallazgos ordenados (ranura, más repetida primero). Un capítulo cuenta una vez por apertura y ranura. */
export function lintFormulaicOpenings(experiences: Iterable<unknown>): FormulaicOpeningFinding[] {
  const count = new Map<string, Map<string, number>>();
  const total = new Map<string, number>();
  for (const exp of experiences) {
    for (const [slot, keys] of slotsOf(exp)) {
      total.set(slot, (total.get(slot) ?? 0) + 1);
      const m = count.get(slot) ?? new Map<string, number>();
      for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
      count.set(slot, m);
    }
  }
  const out: FormulaicOpeningFinding[] = [];
  for (const [slot, m] of count) {
    const t = total.get(slot) ?? 0;
    for (const [opening, n] of m) {
      if (n >= FORMULAIC_MIN_CHAPTERS && n / t >= FORMULAIC_MIN_SHARE) out.push({ slot, opening, chapters: n, total: t });
    }
  }
  const order = ['hero_lead', 'reflection', 'bridge', 'why', 'apply'];
  return out.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot) || b.chapters - a.chapters || a.opening.localeCompare(b.opening));
}

/** Aviso de calidad del paquete: `formulaic_opening:<ranura>:<apertura>:<capítulos>/<total>`. */
export function formulaicOpeningWarnings(experiences: Iterable<unknown>): string[] {
  return lintFormulaicOpenings(experiences).map((f) => `formulaic_opening:${f.slot}:${f.opening.replace(/\s+/g, '_')}:${f.chapters}/${f.total}`);
}
