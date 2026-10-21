import { ACADEMIC_LIMITS, AcademicContextV1, Competency, LearningOutcome, emptyAcademicContext } from './academic-context';
import { bloomLevelOf } from './bloom';
import { hasDocuments } from './proposed-context';
import { normTokens } from '../coherence/normalize';
import type { PedagogicalProfile } from '../pedagogy/pedagogy-profile';

/**
 * r63 · Resultados del perfil pedagógico → modelo de resultados (contexto académico) y vínculos con los capítulos.
 *
 * Puro: sin DB, sin red, sin reloj, sin IA. Lo usan el guardado del perfil, «Usar este diseño», el Prebrief y la
 * recomendación (vista previa), así un curso SIN documento tiene la misma coherencia académica que uno con documento.
 *
 * 1. `academicContextFromProfile` — normalización determinista. Los textos de `learningOutcomes.know` / `.do` pasan a
 *    resultados RA (en ese orden: saber, después saber hacer) y `competencies` a CO, con ids estables:
 *      - un texto que ya está en el contexto (comparado por texto normalizado: sin tildes, mayúsculas ni puntuación)
 *        conserva su id; nunca se duplica (tampoco entre saber / saber hacer / competencias del mismo perfil);
 *      - un texto nuevo toma el siguiente id libre (nunca reutiliza uno que el puente ya usó: `record.next`);
 *      - un resultado que agregó el puente y el docente quitó del perfil se quita (si nadie lo editó en el contexto);
 *      - los que vienen de otro lado (propuesta de Cursia, escritos en «Lo que entendimos») no se tocan.
 *    Precedencia: documento > perfil. Con un contexto leído de un documento no se cambia NADA (los cursos importados
 *    siguen exactamente igual); los textos del perfil que no están en el documento se informan (`ignored`).
 *    Idempotente: el mismo perfil sobre el contexto que produjo devuelve `action: 'none'` (sin versión nueva).
 *    Los datos quedan `provided` (son del perfil del curso, no una propuesta de Cursia: «escritos por ti»).
 *
 * 2. `planDocumentlessLinks` — vínculos capítulo ↔ resultado SIN documento (sin unidades que apoyen la coincidencia):
 *    similitud léxica determinista entre el resultado y el título + objetivo + descripción del capítulo, sobre raíces de
 *    5 letras (activación / activar, emergencia / emergencias) sin palabras vacías ni verbos de Bloom, ponderada por lo
 *    raro que es cada término entre los capítulos (IDF). Un vínculo exige puntaje ≥ LINK_SCORE_MIN y al menos
 *    LINK_SHARED_MIN términos en común; si un resultado no tiene ningún capítulo así, queda AMBIGUO («requiere
 *    revisión»): nunca se fuerza un vínculo. Las competencias son transversales por definición (sin documento no
 *    están atadas a una unidad): van a todos los capítulos de contenido que trabajan algún resultado.
 */

export const PROFILE_OUTCOMES_VERSION = 1 as const;
/** Clave de courses.metadata con lo que agregó el puente (id → texto normalizado) y el próximo id libre. */
export const PROFILE_OUTCOMES_KEY = 'academicFromProfile';

export interface ProfileOutcomesRecord {
  version: typeof PROFILE_OUTCOMES_VERSION;
  /** id → texto normalizado con el que el puente lo agregó. */
  items: Record<string, string>;
  /** Próximo número libre por prefijo (nunca se reutiliza un id que el puente ya usó). */
  next: { RA: number; CO: number };
}

export function parseProfileOutcomesRecord(v: unknown): ProfileOutcomesRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, any>;
  if (o.version !== PROFILE_OUTCOMES_VERSION || !o.items || typeof o.items !== 'object' || Array.isArray(o.items)) return null;
  const items: Record<string, string> = {};
  for (const [k, t] of Object.entries(o.items)) if (/^(RA|CO)[0-9]{1,3}$/.test(k) && typeof t === 'string') items[k] = t;
  const n = (x: unknown) => (Number.isInteger(x) && (x as number) >= 1 ? (x as number) : 1);
  return { version: PROFILE_OUTCOMES_VERSION, items, next: { RA: n(o.next && o.next.RA), CO: n(o.next && o.next.CO) } };
}

/** Texto normalizado para comparar resultados: sin tildes, minúsculas, sin puntuación, espacios colapsados. */
export function normalizeOutcomeText(s: string): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
}

export type ProfileOutcomesAction = 'none' | 'create' | 'update' | 'skip';
export type ProfileOutcomesSkip = 'NO_PROFILE_OUTCOMES' | 'DOCUMENT_CONTEXT';

export interface ProfileOutcomesResult {
  action: ProfileOutcomesAction;
  reason: ProfileOutcomesSkip | null;
  /** El contexto que debe quedar vigente (null si no hay nada que guardar ni usar). */
  context: AcademicContextV1 | null;
  record: ProfileOutcomesRecord | null;
  added: string[];
  removed: string[];
  /** Textos del perfil repetidos (por texto normalizado) que no se duplicaron. */
  duplicates: string[];
  /** Con documento: textos del perfil que el documento no trae (el documento manda; no se agregan). */
  ignored: string[];
}

interface Entry { kind: 'know' | 'do' | 'competency'; text: string; key: string }

function profileEntries(p: PedagogicalProfile | null): { entries: Entry[]; duplicates: string[] } {
  const lo = p && p.learningOutcomes;
  const raw: Entry[] = [];
  const push = (kind: Entry['kind'], xs: unknown) => {
    for (const x of Array.isArray(xs) ? xs : []) {
      const text = String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, ACADEMIC_LIMITS.outcomeText);
      if (text) raw.push({ kind, text, key: normalizeOutcomeText(text) });
    }
  };
  if (lo) { push('know', lo.know); push('do', lo.do); push('competency', lo.competencies); }
  const seen = new Set<string>();
  const entries: Entry[] = [];
  const duplicates: string[] = [];
  for (const e of raw) {
    if (!e.key) continue;
    if (seen.has(e.key)) { duplicates.push(e.text); continue; }
    seen.add(e.key);
    entries.push(e);
  }
  return { entries, duplicates };
}

const idNum = (id: string) => Number(id.replace(/\D/g, '')) || 0;

/**
 * Contexto académico que corresponde al perfil pedagógico (ver el comentario del archivo). `current` es el contexto
 * vigente (o null) y `record` lo que el puente agregó antes (courses.metadata.academicFromProfile).
 */
export function academicContextFromProfile(
  current: AcademicContextV1 | null,
  profile: PedagogicalProfile | null,
  record: ProfileOutcomesRecord | null,
): ProfileOutcomesResult {
  const { entries, duplicates } = profileEntries(profile);
  const none = (action: ProfileOutcomesAction, reason: ProfileOutcomesSkip | null, ignored: string[] = []): ProfileOutcomesResult => ({
    action, reason, context: current, record, added: [], removed: [], duplicates, ignored,
  });
  if (hasDocuments(current)) {
    const have = new Set([...current!.outcomes.map((o) => normalizeOutcomeText(o.text)), ...current!.competencies.map((c) => normalizeOutcomeText(c.text))]);
    return none('skip', 'DOCUMENT_CONTEXT', entries.filter((e) => !have.has(e.key)).map((e) => e.text));
  }
  if (!entries.length) return none('skip', 'NO_PROFILE_OUTCOMES');

  const base: AcademicContextV1 = current ? JSON.parse(JSON.stringify(current)) : emptyAcademicContext();
  const wanted = new Set(entries.map((e) => e.key));
  const items: Record<string, string> = { ...(record ? record.items : {}) };
  const removed: string[] = [];
  // Lo que agregó el puente y ya no está en el perfil (y nadie editó en el contexto) se quita.
  const drop = (id: string, text: string) => {
    const was = items[id];
    if (was === undefined) return false;
    if (normalizeOutcomeText(text) !== was) { delete items[id]; return false; } // editado en el contexto: ya no es del puente
    if (wanted.has(was)) return false;
    delete items[id];
    removed.push(id);
    return true;
  };
  base.outcomes = base.outcomes.filter((o) => !drop(o.id, o.text));
  base.competencies = base.competencies.filter((c) => !drop(c.id, c.text));
  for (const id of Object.keys(items)) if (!base.outcomes.some((o) => o.id === id) && !base.competencies.some((c) => c.id === id)) delete items[id];

  const have = new Set([...base.outcomes.map((o) => normalizeOutcomeText(o.text)), ...base.competencies.map((c) => normalizeOutcomeText(c.text))]);
  const next = {
    RA: Math.max(record ? record.next.RA : 1, base.outcomes.reduce((m, o) => Math.max(m, idNum(o.id) + 1), 1)),
    CO: Math.max(record ? record.next.CO : 1, base.competencies.reduce((m, c) => Math.max(m, idNum(c.id) + 1), 1)),
  };
  const added: string[] = [];
  for (const e of entries) {
    if (have.has(e.key)) continue;
    have.add(e.key);
    if (e.kind === 'competency') {
      if (base.competencies.length >= ACADEMIC_LIMITS.competencies) continue;
      const id = `CO${next.CO++}`;
      const c: Competency = { id, text: e.text, status: 'provided', sources: [] };
      base.competencies.push(c);
      items[id] = e.key;
      added.push(id);
    } else {
      if (base.outcomes.length >= ACADEMIC_LIMITS.outcomes) continue;
      const id = `RA${next.RA++}`;
      // El dominio es el del perfil (saber / saber hacer): así la derivación de vuelta al perfil no cambia nada.
      const o: LearningOutcome = { id, text: e.text, level: bloomLevelOf(e.text), domain: e.kind, status: 'provided', sources: [] };
      base.outcomes.push(o);
      items[id] = e.key;
      added.push(id);
    }
  }
  const nextRecord: ProfileOutcomesRecord = { version: PROFILE_OUTCOMES_VERSION, items, next };
  if (!added.length && !removed.length) return { ...none('none', null), record: nextRecord };
  return { action: current ? 'update' : 'create', reason: null, context: base, record: nextRecord, added, removed, duplicates, ignored: [] };
}

// ── 2. Vínculos sin documento ──────────────────────────────────────────────────────────────────────────────

export const LINKING_VERSION = 1 as const;
/** Puntaje mínimo (contención ponderada del resultado en el capítulo) para un vínculo confiable. */
export const LINK_SCORE_MIN = 0.3;
/** Términos en común mínimos (salvo resultados de uno o dos términos). */
export const LINK_SHARED_MIN = 2;
/** Un resultado se vincula también a otros capítulos que le encajan casi igual de bien (≥ 80 % del mejor). */
export const LINK_NEAR_BEST = 0.8;
export const LINK_MAX_CHAPTERS = 3;
const STEM_LEN = 5;
/** Palabras que no dicen de qué trata un resultado ni un capítulo. */
const GENERIC = new Set([
  'estudiante', 'estudiantes', 'participante', 'participantes', 'aprendiz', 'capaz', 'forma', 'manera', 'propio', 'propia', 'adecuado', 'adecuada',
  'correcto', 'correcta', 'correctamente', 'adecuadamente', 'basico', 'basica', 'general', 'diferente', 'distinto', 'tipo', 'nivel', 'mismo', 'misma',
  'todo', 'toda', 'traves', 'partir', 'sera', 'poder', 'puede', 'pueden', 'curso', 'capitulo', 'modulo', 'tema', 'unidad', 'introduccion', 'conceptos', 'concepto',
]);

/** Raíces de los términos con contenido (sin palabras vacías, genéricas ni verbos de Bloom). */
export function conceptStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of normTokens(text)) {
    if (t.length <= 2 || /^\d+$/.test(t) || GENERIC.has(t) || bloomLevelOf(t) !== null) continue;
    out.add(t.length > STEM_LEN ? t.slice(0, STEM_LEN) : t);
  }
  return out;
}

export interface LinkChapterInput {
  id: string;
  title: string;
  objective: string | null;
  description?: string | null;
  /** Vínculos que ya tiene (del docente o anteriores): se conservan y cuentan para la cobertura. */
  outcomeIds: string[];
  /** false = no se le sugiere nada (práctica, o el docente lo desvinculó a propósito). */
  eligible: boolean;
}

export interface DocumentlessLinkPlan {
  linkingVersion: typeof LINKING_VERSION;
  /** Capítulos elegibles SIN vínculos para los que hay una sugerencia confiable (RA primero, después CO). */
  links: { chapterId: string; suggested: string[] }[];
  /** Resultados sin ningún capítulo con coincidencia confiable: requieren revisión (nunca se vinculan a la fuerza). */
  ambiguous: { id: string; text: string; bestChapterId: string | null; score: number }[];
  /** Capítulos elegibles sin vínculos que no encajan con ningún resultado (requieren revisión). */
  unmatchedChapterIds: string[];
  /** Puntajes resultado × capítulo (redondeados), para mostrar y probar. */
  scores: { outcomeId: string; chapterId: string; score: number; shared: number }[];
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const cmpId = (a: string, b: string) => (a.startsWith('RA') ? 0 : 1) - (b.startsWith('RA') ? 0 : 1) || idNum(a) - idNum(b);

/** ¿El contexto no tiene documento ni unidades? (entonces los vínculos salen de `planDocumentlessLinks`). */
export function isDocumentlessContext(ctx: AcademicContextV1 | null | undefined): boolean {
  return !!ctx && !hasDocuments(ctx) && ctx.units.length === 0;
}

export function planDocumentlessLinks(ctx: AcademicContextV1, chapters: LinkChapterInput[]): DocumentlessLinkPlan {
  const chText = (c: LinkChapterInput) => [c.title, c.objective || '', c.description || ''].join(' ');
  const chStems = chapters.map((c) => conceptStems(chText(c)));
  const N = chapters.length;
  const df = new Map<string, number>();
  for (const s of chStems) for (const t of s) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t: string) => Math.log(1 + N / Math.max(1, df.get(t) || 0));
  const known = new Set([...ctx.outcomes.map((o) => o.id), ...ctx.competencies.map((c) => c.id)]);
  const current = new Map(chapters.map((c) => [c.id, c.outcomeIds.filter((x) => known.has(x))]));
  const covered = new Set(chapters.flatMap((c) => current.get(c.id)!));
  const open = chapters.filter((c) => c.eligible && !current.get(c.id)!.length);
  const plan = new Map<string, Set<string>>(open.map((c) => [c.id, new Set<string>()]));

  const scores: DocumentlessLinkPlan['scores'] = [];
  const scoreOf = new Map<string, { score: number; shared: number }>();
  for (const o of ctx.outcomes) {
    const os = conceptStems(o.text);
    const total = [...os].reduce((a, t) => a + idf(t), 0);
    chapters.forEach((c, i) => {
      let w = 0;
      let shared = 0;
      for (const t of os) if (chStems[i].has(t)) { w += idf(t); shared++; }
      const s = { score: total > 0 ? round3(w / total) : 0, shared };
      scoreOf.set(`${o.id}|${c.id}`, s);
      scores.push({ outcomeId: o.id, chapterId: c.id, ...s });
    });
  }
  const reliable = (oid: string, cid: string) => {
    const s = scoreOf.get(`${oid}|${cid}`)!;
    const o = ctx.outcomes.find((x) => x.id === oid)!;
    return s.score >= LINK_SCORE_MIN && s.shared >= Math.min(LINK_SHARED_MIN, conceptStems(o.text).size);
  };

  // a) Cada resultado → el capítulo que mejor le encaja (y los que le encajan casi igual), si la coincidencia es confiable.
  const ambiguous: DocumentlessLinkPlan['ambiguous'] = [];
  for (const o of ctx.outcomes) {
    const ranked = chapters.filter((c) => c.eligible || current.get(c.id)!.length)
      .map((c, i) => ({ c, i, ...scoreOf.get(`${o.id}|${c.id}`)! }))
      .sort((a, b) => b.score - a.score || b.shared - a.shared || a.i - b.i);
    const ok = ranked.filter((r) => reliable(o.id, r.c.id));
    if (covered.has(o.id)) continue; // ya lo trabaja un capítulo (decisión anterior): no se agregan más
    if (!ok.length) {
      ambiguous.push({ id: o.id, text: o.text, bestChapterId: ranked.length && ranked[0].score > 0 ? ranked[0].c.id : null, score: ranked.length ? ranked[0].score : 0 });
      continue;
    }
    for (const r of ok.filter((x) => x.score >= ok[0].score * LINK_NEAR_BEST).slice(0, LINK_MAX_CHAPTERS)) {
      if (plan.has(r.c.id)) plan.get(r.c.id)!.add(o.id);
    }
  }
  // b) Cada capítulo abierto sin resultado → el resultado que mejor le encaja, si la coincidencia es confiable.
  for (const c of open) {
    const set = plan.get(c.id)!;
    if (set.size) continue;
    const best = ctx.outcomes.map((o) => ({ o, ...scoreOf.get(`${o.id}|${c.id}`)! })).filter((x) => reliable(x.o.id, c.id))
      .sort((a, b) => b.score - a.score || b.shared - a.shared || cmpId(a.o.id, b.o.id))[0];
    if (best) set.add(best.o.id);
  }
  // c) Competencias: transversales. Van a todos los capítulos abiertos que trabajan algún resultado (si el curso no
  //    declara resultados, a todos los capítulos abiertos). Un capítulo sin resultado queda sin vínculos: se revisa.
  const unmatchedChapterIds = open.filter((c) => !plan.get(c.id)!.size && ctx.outcomes.length > 0).map((c) => c.id);
  for (const c of open) {
    const set = plan.get(c.id)!;
    if (!set.size && ctx.outcomes.length > 0) continue;
    for (const co of ctx.competencies) set.add(co.id);
  }
  const links = open
    .map((c) => ({ chapterId: c.id, suggested: [...plan.get(c.id)!].sort(cmpId).slice(0, ACADEMIC_LIMITS.outcomeIdsPerItem) }))
    .filter((l) => l.suggested.length);
  return { linkingVersion: LINKING_VERSION, links, ambiguous, unmatchedChapterIds, scores };
}
