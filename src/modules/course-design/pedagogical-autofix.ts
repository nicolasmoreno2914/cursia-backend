import type { AcademicContextV1 } from '../academic-context/academic-context';
import { sortOutcomeIds } from '../academic-context/blueprint-academic';
import { sectorFromAcademicContext, sectorFromKeywords } from '../course-facts/course-facts';
import { normTokens, stripToAscii } from '../coherence/normalize';

/**
 * r71 · «Cursia optimizó tu curso» (autocorrección pedagógica). Puro y determinista: sin DB, sin red, sin IA, USD 0.
 *
 * Cuando la información está incompleta, Cursia actúa como diseñador curricular y completa lo que se puede deducir CON
 * EVIDENCIA del propio curso (documento, nombre, unidades, módulos y capítulos), sin tocar ninguna decisión del docente:
 *   1. vínculos por términos (la misma sugerencia de «Vincular automáticamente») en capítulos de contenido sin vínculos;
 *   2. resultado sin capítulo → el capítulo SIN vínculos del módulo que más se relaciona con él (términos del resultado y
 *      familias de conceptos: interacción, comunicación, vocabulario…); sin un módulo plausible, o sin un capítulo libre en
 *      él, NO se fuerza: queda como propuesta («Vincular a…» o agregar un capítulo), que decide el docente;
 *   3. capítulo de contenido sin vínculos → los resultados de su módulo (con documento, o si es una «Profundización» del
 *      módulo: lo profundiza por definición);
 *   4. competencia sin capítulo → la práctica integradora de cada módulo (donde se pone en juego con los resultados del
 *      módulo); sin prácticas, propuesta;
 *   5. dato del curso que falta y el documento permite deducir (hoy: el sector, desde el área o el nivel educativo) →
 *      inferido y editable.
 * Nunca inventa datos institucionales ni requisitos legales, nunca pisa un vínculo existente (del documento o del
 * docente), un capítulo que el docente desvinculó a propósito, ni un dato que el docente escribió. Cada cambio lleva su
 * motivo, el valor anterior (para «Deshacer») y una clave estable: lo que el docente deshizo no se vuelve a aplicar
 * (`declined`), y correr la autocorrección dos veces no cambia nada (idempotente).
 */

export const AUTOFIX_KEY = 'pedagogicalAutofix';
export const AUTOFIX_ORIGIN = 'cursia-autofix' as const;
export const AUTOFIX_VERSION = 1 as const;

export type AutofixKind = 'chapter_terms' | 'cover_outcome' | 'chapter_outcomes' | 'competency' | 'context_field';

export interface AutofixChapter {
  id: string;
  moduleId: string;
  position: number;
  title: string;
  objective: string | null;
  description: string | null;
  kind: 'content' | 'practice';
  outcomeIds: string[];
  /** El docente le quitó los vínculos a propósito (design pins): Cursia no lo vuelve a vincular. */
  noLinks?: boolean;
}

export interface AutofixModule {
  id: string;
  position: number;
  title: string;
  objective: string | null;
  description: string | null;
}

export interface AutofixChange {
  /** Clave estable: idempotencia y «Deshacer» (lo deshecho no se vuelve a aplicar). */
  id: string;
  kind: AutofixKind;
  origin: typeof AUTOFIX_ORIGIN;
  /** Lo que hizo Cursia, en una línea para el docente. */
  title: string;
  /** Por qué (la evidencia). */
  reason: string;
  target: { chapterId?: string; chapterTitle?: string; moduleTitle?: string; field?: string; outcomeIds?: string[] };
  before: string[] | string | null;
  after: string[] | string;
}

export interface AutofixProposal {
  id: string;
  kind: 'uncovered_outcome' | 'competency';
  title: string;
  detail: string;
  outcomeId: string;
  /** Capítulo que propone Cursia (el docente decide con un clic); null = no hay uno plausible: agregar un capítulo. */
  chapterId: string | null;
  chapterTitle: string | null;
}

export interface AutofixInput {
  ctx: AcademicContextV1 | null;
  modules: AutofixModule[];
  chapters: AutofixChapter[];
  /** Vínculos por términos que sugiere la vinculación de siempre (capítulo sin vínculos → resultados). */
  lexical?: ReadonlyMap<string, string[]>;
  /** Claves que el docente deshizo. */
  declined?: ReadonlySet<string>;
  /** Datos del curso vigentes (lo que ya hay manda: nunca se pisa). */
  context: { sector: string | null };
  /** Hay un documento leído (no un contexto armado desde el perfil). */
  hasDocument: boolean;
}

export interface AutofixPlan {
  changes: AutofixChange[];
  proposals: AutofixProposal[];
  /** Por resultado sin capítulo: el capítulo que propone Cursia (aplicado o no). Lo usa la propuesta (paso 5). */
  suggestions: Record<string, { chapterId: string; chapterTitle: string } | null>;
}

// ── Relación resultado ↔ capítulo/módulo ─────────────────────────────────────────────────────────────────────────

/** Modificadores que no distinguen un resultado de otro («básicas», «fundamental», «sencillas»…). */
const GENERIC = new Set(['basico', 'basica', 'inicial', 'fundamental', 'sencillo', 'sencilla', 'general', 'principal', 'relacionado', 'relacionada', 'diverso', 'diversa', 'propio', 'propia', 'nuevo', 'nueva', 'curso', 'estudiante', 'capitulo', 'modulo', 'unidad', 'profundizacion', 'practica', 'integradora']);
/** Familias de conceptos (sobre el texto sin tildes): dos textos de la misma familia hablan de lo mismo con otras palabras. */
const FAMILIES: ReadonlyArray<[string, RegExp]> = [
  ['interacción oral', /\b(pregunt\w*|respond\w*|respuest\w*|dialog\w*|conversa\w*|interact\w*|interacc\w*|entrevist\w*)/],
  ['comunicación', /\b(comunic\w*|mensaj\w*|expres\w*|oral\w*|escrit\w*|habla\w*|speaking|writing|listening|reading|lectur\w*|escuch\w*|auditiv\w*)/],
  ['vocabulario', /\b(vocabul\w*|expresion\w*|palabra\w*|lexic\w*|frase\w*)/],
  ['vida cotidiana', /\b(cotidian\w*|diari\w*|rutina\w*|habitual\w*)/],
  ['cálculo', /\b(calcul\w*|operacion\w*|aritmet\w*|matemat\w*)/],
  ['análisis', /\b(analiz\w*|analisis|interpret\w*|diagnost\w*)/],
  ['seguridad', /\b(riesgo\w*|seguridad|prevenc\w*|peligr\w*|emergenc\w*)/],
  ['normativa', /\b(norma\w*|legal\w*|regulac\w*|leyes|ley)\b/],
  ['gestión', /\b(planific\w*|planea\w*|organiz\w*|gestion\w*|administr\w*)/],
  ['datos', /\b(dato\w*|estadistic\w*|grafic\w*|tabla\w*)/],
];
const VERB_RE = /(ar|er|ir|arse|erse|irse)$/;
/** Misma raíz de 7 letras («expresiones» ≈ «expresión», «comunicarse» ≈ «comunicación»), como la cobertura de contenidos. */
const same = (a: string, b: string) => a === b || (a.length >= 7 && b.length >= 7 && a.slice(0, 7) === b.slice(0, 7));

/** Términos que distinguen el texto: sin el verbo inicial (no cuenta solo) ni modificadores genéricos. */
function contentTokens(text: string): string[] {
  const t = normTokens(text);
  const rest = t.length > 1 && VERB_RE.test(t[0]) ? t.slice(1) : t;
  return [...new Set(rest.filter((w) => w.length >= 3 && !GENERIC.has(w)))];
}
function families(text: string): Set<string> {
  const s = stripToAscii(text);
  return new Set(FAMILIES.filter(([, re]) => re.test(s)).map(([n]) => n));
}
const textOf = (x: { title: string; objective: string | null; description: string | null }) => [x.title, x.objective || '', x.description || ''].join(' ');

interface Relation { score: number; terms: string[]; families: string[] }

function relation(outcome: string, chaptersText: string, moduleText: string, courseWide: Set<string>): Relation {
  const toks = contentTokens(outcome).filter((w) => !courseWide.has(w));
  const ch = normTokens(chaptersText);
  const md = normTokens(moduleText);
  const inCh = toks.filter((w) => ch.some((y) => same(w, y)));
  const inMd = toks.filter((w) => !inCh.includes(w) && md.some((y) => same(w, y)));
  const fo = families(outcome);
  const fx = families(`${chaptersText} ${moduleText}`);
  const shared = [...fo].filter((f) => fx.has(f));
  // Para el docente, las palabras tal como están en el resultado («expresiones», «inglés»), no su raíz.
  const original = new Map<string, string>();
  for (const w of outcome.split(/[^\p{L}\p{N}]+/u)) { const t = normTokens(w)[0]; if (t && !original.has(t)) original.set(t, w.toLowerCase()); }
  return { score: 2 * inCh.length + inMd.length + shared.length, terms: [...inCh, ...inMd].map((t) => original.get(t) || t), families: shared };
}

/** Sector a partir del documento (área, programa o nivel educativo), con su evidencia. Sin evidencia → null. */
export function inferSector(ctx: AcademicContextV1 | null | undefined): { value: string; evidence: string } | null {
  if (!ctx || !Array.isArray(ctx.documents) || !ctx.documents.length) return null;
  const kw = sectorFromKeywords(ctx);
  if (kw) return { value: kw, evidence: 'el área que nombra el documento' };
  const prog = sectorFromAcademicContext(ctx);
  if (prog) return { value: prog, evidence: 'el programa académico del documento' };
  const lvl = ctx.identity && ctx.identity.educationLevel;
  const v = lvl && lvl.status !== 'missing' ? lvl.value : null;
  // Educación básica o media (colegio): el curso es del sector educativo. Universidad o técnico no dicen el área.
  if (v && (v.level === 'basic' || v.level === 'secondary') && lvl.sources && lvl.sources.length) {
    const ex = String(lvl.sources[0].excerpt || v.text || '').replace(/\s*\|\s*/g, ': ').trim();
    return { value: 'Educación', evidence: ex ? `el documento indica «${ex.slice(0, 120)}»` : 'el nivel educativo del documento' };
  }
  return null;
}

const DEEPENING_RE = /^profundizaci[oó]n\b/i;
const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function planAutofix(input: AutofixInput): AutofixPlan {
  const changes: AutofixChange[] = [];
  const proposals: AutofixProposal[] = [];
  const suggestions: AutofixPlan['suggestions'] = {};
  const declined = input.declined || new Set<string>();
  const ctx = input.ctx;
  const mods = [...input.modules].sort((a, b) => a.position - b.position);
  const modPos = new Map(mods.map((m, i) => [m.id, i]));
  const chs = [...input.chapters].sort((a, b) => (modPos.get(a.moduleId) ?? 0) - (modPos.get(b.moduleId) ?? 0) || a.position - b.position);
  const modOf = new Map(mods.map((m) => [m.id, m]));
  const after = new Map<string, string[]>(); // vínculos nuevos de esta corrección
  const linksOf = (c: AutofixChapter) => after.get(c.id) || c.outcomeIds;
  const eligible = (c: AutofixChapter) => c.kind === 'content' && !c.noLinks && !c.outcomeIds.length && !after.has(c.id);
  const coveredIds = () => new Set(chs.flatMap((c) => linksOf(c)));
  const set = (c: AutofixChapter, kind: AutofixKind, id: string, ids: string[], title: string, reason: string) => {
    const next = sortOutcomeIds([...new Set(ids)]);
    after.set(c.id, next);
    const m = modOf.get(c.moduleId);
    changes.push({ id, kind, origin: AUTOFIX_ORIGIN, title, reason, target: { chapterId: c.id, chapterTitle: c.title, moduleTitle: m ? m.title : undefined, outcomeIds: next }, before: [...c.outcomeIds], after: next });
  };

  if (ctx) {
    const known = new Set([...ctx.outcomes.map((o) => o.id), ...ctx.competencies.map((c) => c.id)]);
    // 1 · Vínculos por términos (la vinculación de siempre).
    for (const c of chs) {
      const sug = (input.lexical && input.lexical.get(c.id)) || [];
      const ids = sug.filter((x) => known.has(x));
      const key = `chapter:${c.id}`;
      if (!ids.length || !eligible(c) || declined.has(key)) continue;
      set(c, 'chapter_terms', key, ids, `«${short(c.title)}» → ${sortOutcomeIds(ids).join(', ')}`, 'El capítulo comparte términos con esos resultados.');
    }

    // 2 · Resultados sin capítulo.
    const contentByModule = new Map(mods.map((m) => [m.id, chs.filter((c) => c.moduleId === m.id && c.kind === 'content')]));
    const modText = new Map(mods.map((m) => [m.id, textOf(m)]));
    const chText = new Map(mods.map((m) => [m.id, contentByModule.get(m.id)!.map(textOf).join(' ')]));
    // Términos de todo el curso (más de la mitad de los módulos, con 3 o más): no distinguen un módulo de otro.
    const courseWide = new Set<string>();
    if (mods.length >= 3) {
      const counts = new Map<string, number>();
      for (const m of mods) for (const w of new Set(normTokens(`${modText.get(m.id)} ${chText.get(m.id)}`))) counts.set(w, (counts.get(w) || 0) + 1);
      for (const [w, n] of counts) if (n > mods.length / 2) courseWide.add(w);
    }
    for (const o of ctx.outcomes) {
      if (coveredIds().has(o.id)) continue;
      const scored = mods.map((m) => ({ m, r: relation(o.text, chText.get(m.id) || '', modText.get(m.id) || '', courseWide) })).sort((a, b) => b.r.score - a.r.score || (modPos.get(a.m.id)! - modPos.get(b.m.id)!));
      const best = scored[0];
      const second = scored[1];
      const plausible = !!best && (best.r.score >= 2 || (best.r.score >= 1 && (!second || second.r.score < best.r.score)));
      const why = best ? [...best.r.terms.map((t) => `«${t}»`), ...best.r.families].slice(0, 4).join(', ') : '';
      const inModule = plausible ? (contentByModule.get(best.m.id) || []) : [];
      // El capítulo del módulo que más se relaciona; entre los libres, el de mayor relación (empate: el primero).
      const rank = (c: AutofixChapter) => relation(o.text, textOf(c), '', courseWide).score;
      const free = inModule.filter(eligible).sort((a, b) => rank(b) - rank(a) || a.position - b.position);
      const anyBest = [...inModule].sort((a, b) => rank(b) - rank(a) || a.position - b.position)[0] || null;
      const key = `cover:${o.id}`;
      const target = free[0] || null;
      suggestions[o.id] = target ? { chapterId: target.id, chapterTitle: target.title } : anyBest ? { chapterId: anyBest.id, chapterTitle: anyBest.title } : null;
      if (target && !declined.has(key)) {
        set(target, 'cover_outcome', key, [o.id], `${o.id} ahora se desarrolla en «${short(target.title)}»`,
          `${o.id} («${short(o.text, 90)}») no estaba en ningún capítulo. El módulo «${best.m.title}» es el que más se relaciona con él${why ? ` (${why})` : ''} y este capítulo no tenía resultados.`);
        continue;
      }
      const sug = suggestions[o.id];
      proposals.push({
        id: key, kind: 'uncovered_outcome', outcomeId: o.id, chapterId: sug ? sug.chapterId : null, chapterTitle: sug ? sug.chapterTitle : null,
        title: `${o.id} («${short(o.text, 90)}») no está en ningún capítulo.`,
        detail: sug
          ? `Cursia propone vincularlo a «${short(sug.chapterTitle)}»${plausible ? ` (módulo «${best.m.title}»${why ? `: ${why}` : ''})` : ''}. Tú decides: vincúlalo o agrega un capítulo que lo desarrolle.`
          : 'Ningún capítulo se relaciona con él con claridad. Vincúlalo al capítulo que lo trabaja o agrega un capítulo que lo desarrolle.',
      });
    }

    // 3 · Capítulos de contenido sin vínculos → los resultados de su módulo.
    for (const c of chs) {
      if (!eligible(c)) continue;
      const key = `chapter:${c.id}`;
      if (declined.has(key)) continue;
      const deepening = DEEPENING_RE.test(c.title.trim());
      if (!input.hasDocument && !deepening) continue; // sin documento, lo que no encaja se revisa (r63): nunca se fuerza
      const mod = modOf.get(c.moduleId);
      const outs = sortOutcomeIds([...new Set((contentByModule.get(c.moduleId) || []).filter((x) => x.id !== c.id).flatMap((x) => x.outcomeIds))]).filter((x) => known.has(x) && !x.startsWith('CO'));
      if (!outs.length || !mod) continue;
      set(c, 'chapter_outcomes', key, outs, `«${short(c.title)}» → ${outs.join(', ')}`,
        deepening ? `Profundiza el módulo «${mod.title}»: trabaja los resultados de ese módulo.` : `El documento no le asigna un resultado propio: trabaja los resultados de su módulo «${mod.title}».`);
    }

    // 4 · Competencias sin capítulo → la práctica integradora de cada módulo.
    const linkedCo = coveredIds();
    const comps = ctx.competencies.filter((co) => !linkedCo.has(co.id));
    if (comps.length) {
      const practices = chs.filter((c) => c.kind === 'practice' && !c.noLinks && !c.outcomeIds.length && !declined.has(`competency:${c.id}`));
      for (const p of practices) {
        // Lo que el módulo ya tenía (no lo que esta corrección agregó: «Deshacer» de un resultado no lo deja en la práctica).
        const moduleOuts = (contentByModule.get(p.moduleId) || []).flatMap((x) => x.outcomeIds).filter((x) => !x.startsWith('CO'));
        set(p, 'competency', `competency:${p.id}`, [...moduleOuts, ...comps.map((co) => co.id)], `«${short(p.title)}» pone en juego ${comps.map((co) => co.id).join(', ')}`,
          `La práctica integradora del módulo aplica sus resultados en una situación completa: es donde se evidencia la competencia${comps.length > 1 ? 's' : ''} ${comps.map((co) => `${co.id} («${short(co.text, 60)}»)`).join(', ')}.`);
      }
      if (!practices.length) {
        for (const co of comps) {
          proposals.push({ id: `competency:${co.id}`, kind: 'competency', outcomeId: co.id, chapterId: null, chapterTitle: null,
            title: `La competencia ${co.id} no está vinculada a ningún capítulo.`,
            detail: 'Vincúlala a los capítulos o Actividades de Aplicación donde se pone en juego (Cursia no la asigna sin una práctica integradora).' });
        }
      }
    }
  }

  // 5 · Datos del curso que faltan y el documento permite deducir.
  if (!input.context.sector && !declined.has('context:sector')) {
    const s = inferSector(ctx);
    if (s) {
      changes.push({ id: 'context:sector', kind: 'context_field', origin: AUTOFIX_ORIGIN, title: `Sector del curso: ${s.value} (inferido, editable)`,
        reason: `Faltaba el sector; ${s.evidence}.`, target: { field: 'sector' }, before: null, after: s.value });
    }
  }
  return { changes, proposals, suggestions };
}

// ── Registro (courses.metadata.pedagogicalAutofix) ───────────────────────────────────────────────────────────────

export interface AutofixRecord extends AutofixChange {
  batchId: string;
  at: string;
  /** superseded = el docente lo cambió después (o escribió el dato): es decisión suya, Cursia no lo vuelve a tocar. */
  status: 'applied' | 'reverted' | 'superseded';
  revertedAt?: string;
}
export interface AutofixState {
  autofixVersion: typeof AUTOFIX_VERSION;
  changes: AutofixRecord[];
}

export function parseAutofixState(v: unknown): AutofixState {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : null;
  const changes = o && Array.isArray(o.changes) ? (o.changes as AutofixRecord[]).filter((c) => c && typeof c.id === 'string') : [];
  return { autofixVersion: AUTOFIX_VERSION, changes };
}

/** Lo que el docente deshizo (no se vuelve a aplicar). Un cambio aplicado otra vez después de deshacerse ya no cuenta. */
export function declinedKeys(state: AutofixState): Set<string> {
  const last = new Map<string, AutofixRecord>();
  for (const c of state.changes) last.set(c.id, c);
  const out = new Set<string>();
  for (const c of last.values()) {
    if (c.status !== 'reverted' && c.status !== 'superseded') continue;
    out.add(c.id);
    // Un capítulo cuyo cambio se deshizo queda como lo dejó el docente: ningún otro paso lo vuelve a tocar.
    if (c.target && c.target.chapterId) { out.add(`chapter:${c.target.chapterId}`); out.add(`competency:${c.target.chapterId}`); }
  }
  return out;
}
