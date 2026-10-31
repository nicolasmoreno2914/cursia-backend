import type { AcademicContextV1 } from '../academic-context/academic-context';
import { sortOutcomeIds } from '../academic-context/blueprint-academic';
import { sectorFromAcademicContext, sectorFromKeywords } from '../course-facts/course-facts';
import { normTokens, stripToAscii } from '../coherence/normalize';

/**
 * r71 / r72 · «Cursia optimizó tu curso» (autocorrección pedagógica). Puro y determinista: sin DB, sin red, sin IA, USD 0.
 *
 * Cuando la información está incompleta, Cursia actúa como diseñador curricular y completa lo que se puede deducir CON
 * EVIDENCIA del propio curso (documento, nombre, unidades, módulos y capítulos), sin tocar ninguna decisión del docente:
 *   0. (r72) resultado poco preciso («Reconocer vocabulario fundamental») → misma intención, precisada con el idioma del
 *      curso y los temas de sus unidades; el texto original se conserva y se recupera con «Deshacer»;
 *   1. vínculos por términos (la misma sugerencia de «Vincular automáticamente») en capítulos de contenido sin vínculos;
 *   2. resultado sin capítulo → el capítulo SIN vínculos del módulo que más se relaciona con él; (r72) si no hay uno libre,
 *      se AGREGA a los capítulos de contenido con relación justificada (términos o familias de conceptos compartidos), sin
 *      quitar ni reemplazar nada; sin ninguna relación, NO se inventa un vínculo: se propone un ajuste de contenido
 *      (agregar el tema al capítulo más cercano), que decide el docente con un clic;
 *   3. capítulo de contenido sin vínculos → los resultados de su módulo (con documento, o si es una «Profundización» del
 *      módulo); (r72) si el módulo no tiene ninguno, los resultados con los que el capítulo comparte términos;
 *   4. competencia sin capítulo → la práctica integradora de cada módulo; (r72) sin prácticas, el capítulo de cada módulo
 *      que integra más resultados de los que la competencia agrupa (términos o familias compartidas; la única competencia
 *      del curso agrupa todos); curso sin competencias → propuesta revisable desde el objetivo del documento;
 *   5. dato del curso que falta y el documento permite deducir (hoy: el sector) → inferido y editable.
 * Nunca inventa datos institucionales ni requisitos legales, nunca quita un vínculo existente (del documento o del
 * docente), no toca un capítulo que el docente desvinculó a propósito, ni un dato o resultado que el docente escribió.
 * Cada cambio lleva su motivo, el valor anterior (para «Deshacer») y una clave estable: lo que el docente deshizo no se
 * vuelve a aplicar, y correr la autocorrección dos veces no cambia nada (idempotente).
 */

export const AUTOFIX_KEY = 'pedagogicalAutofix';
export const AUTOFIX_ORIGIN = 'cursia-autofix' as const;
export const AUTOFIX_VERSION = 1 as const;
/** r72 · Marca de un resultado cuya redacción precisó Cursia (status 'inferred' con las fuentes del documento). */
export const IMPROVED_OUTCOME_BASIS = 'Redacción precisada por Cursia a partir del documento y de los temas del curso';

export type AutofixKind = 'chapter_terms' | 'cover_outcome' | 'chapter_outcomes' | 'competency' | 'context_field' | 'outcome_wording' | 'content_adjustment' | 'competency_added';

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
  target: { chapterId?: string; chapterTitle?: string; moduleTitle?: string; field?: string; outcomeIds?: string[]; outcomeId?: string };
  before: string[] | string | null;
  after: string[] | string;
  /** r72: vínculos que agrega el cambio (Deshacer quita solo esos; lo demás del capítulo queda como estaba). */
  added?: string[];
}

export interface AutofixProposal {
  id: string;
  kind: 'uncovered_outcome' | 'competency' | 'content_adjustment' | 'missing_competency';
  title: string;
  detail: string;
  outcomeId: string;
  /** Capítulo que propone Cursia (el docente decide con un clic); null = no hay uno plausible: agregar un capítulo. */
  chapterId: string | null;
  chapterTitle: string | null;
  /** r72 · content_adjustment: el tema que se agregaría al capítulo (aceptar = agregarlo y vincular el resultado). */
  topic?: string;
  /** r72 · missing_competency: el texto propuesto (revisable antes de usarlo). */
  text?: string;
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
  /** r72 · nombre del curso (idioma de un curso de idiomas cuando el documento no lo nombra). */
  course?: { name: string | null };
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
/** r72 · Modificadores de tamaño o grado: tampoco dicen QUÉ se aprende («textos cortos», «frases simples»). */
const VAGUE = new Set([...GENERIC, 'corto', 'corta', 'breve', 'simple', 'elemental', 'esencial', 'importante', 'vario', 'varia', 'distinto', 'distinta']);
/** Familias de conceptos (sobre el texto sin tildes): dos textos de la misma familia hablan de lo mismo con otras palabras. */
const FAMILIES: ReadonlyArray<[string, RegExp]> = [
  ['interacción oral', /\b(pregunt\w*|respond\w*|respuest\w*|dialog\w*|conversa\w*|interact\w*|interacc\w*|entrevist\w*)/],
  ['comunicación', /\b(comunic\w*|mensaj\w*|expres\w*|oral\w*|escrit\w*|habla\w*|speaking|writing|listening|reading|lectur\w*|escuch\w*|auditiv\w*)/],
  ['vocabulario', /\b(vocabul\w*|expresion\w*|palabra\w*|lexic\w*|frase\w*)/],
  ['vida cotidiana', /\b(cotidian\w*|diari\w*|rutina\w*|habitual\w*|horario\w*)/],
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
function contentTokens(text: string, generic: ReadonlySet<string> = GENERIC): string[] {
  const t = normTokens(text);
  const rest = t.length > 1 && VERB_RE.test(t[0]) ? t.slice(1) : t;
  return [...new Set(rest.filter((w) => w.length >= 3 && !generic.has(w)))];
}
function families(text: string): Set<string> {
  const s = stripToAscii(text);
  return new Set(FAMILIES.filter(([, re]) => re.test(s)).map(([n]) => n));
}
const textOf = (x: { title: string; objective: string | null; description: string | null }) => [x.title, x.objective || '', x.description || ''].join(' ');

interface Relation { score: number; terms: string[]; families: string[] }

/**
 * Relación de un resultado con un texto de capítulo(s) y su módulo. `chapterFamilyWeight` (r72): con 2, una familia de
 * conceptos que aparece en el PROPIO capítulo («Rutinas, horarios…» ↔ «vida cotidiana») pesa como un término compartido;
 * se usa al elegir capítulos concretos (resultado transversal, capítulo de un módulo sin resultados).
 */
function relation(outcome: string, chaptersText: string, moduleText: string, courseWide: Set<string>, chapterFamilyWeight = 1): Relation {
  const toks = contentTokens(outcome).filter((w) => !courseWide.has(w));
  const ch = normTokens(chaptersText);
  const md = normTokens(moduleText);
  const inCh = toks.filter((w) => ch.some((y) => same(w, y)));
  const inMd = toks.filter((w) => !inCh.includes(w) && md.some((y) => same(w, y)));
  const fo = families(outcome);
  const fc = families(chaptersText);
  const fx = families(`${chaptersText} ${moduleText}`);
  const shared = [...fo].filter((f) => fx.has(f));
  const famScore = shared.reduce((n, f) => n + (fc.has(f) ? chapterFamilyWeight : 1), 0);
  // Para el docente, las palabras tal como están en el resultado («expresiones», «inglés»), no su raíz.
  const original = new Map<string, string>();
  for (const w of outcome.split(/[^\p{L}\p{N}]+/u)) { const t = normTokens(w)[0]; if (t && !original.has(t)) original.set(t, w.toLowerCase()); }
  return { score: 2 * inCh.length + inMd.length + famScore, terms: [...inCh, ...inMd].map((t) => original.get(t) || t), families: shared };
}
const whyOf = (r: Relation) => [...r.terms.map((t) => `«${t}»`), ...r.families].slice(0, 4).join(', ');

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

// ── r72 · Redacción precisa de un resultado (determinista, desde el contexto del curso) ─────────────────────────

const LANGUAGES: ReadonlyArray<[RegExp, string]> = [
  [/\bingl[eé]s\b|\benglish\b/i, 'inglés'], [/\bfranc[eé]s\b|\bfrench\b/i, 'francés'], [/\bportugu[eé]s\b/i, 'portugués'], [/\balem[aá]n\b/i, 'alemán'],
  [/\bitaliano\b/i, 'italiano'], [/\bmandar[ií]n\b|\bchino\b/i, 'chino mandarín'], [/\bjapon[eé]s\b/i, 'japonés'],
];
/** Idioma de un curso de idiomas (nombre de la asignatura o del curso). null = no es un curso de idiomas. */
export function courseLanguage(ctx: AcademicContextV1 | null | undefined, courseName?: string | null): string | null {
  const names = [ctx && ctx.identity && ctx.identity.subjectName && ctx.identity.subjectName.status !== 'missing' ? String(ctx.identity.subjectName.value || '') : '', courseName || ''].join(' ');
  for (const [re, name] of LANGUAGES) if (re.test(names)) return name;
  return null;
}
/** Encabezados que no son un tema («Integración de…», «Repaso…»): no sirven para precisar un resultado. */
const NOT_A_TOPIC_RE = /^(integraci[oó]n|repaso|evaluaci[oó]n|introducci[oó]n|profundizaci[oó]n|pr[aá]ctica|proyecto|cierre|s[ií]ntesis)\b/i;
/** Temas del curso (el primero de cada unidad del documento), sin los que ya nombra el resultado. Máx. 5. */
export function courseTopics(ctx: AcademicContextV1 | null | undefined, exclude: string[] = []): string[] {
  if (!ctx || !Array.isArray(ctx.units)) return [];
  const out: string[] = [];
  for (const u of ctx.units) {
    const first = (u.contents || []).map((c) => String(c.text || '')).find((t) => t.trim()) || '';
    const head = first.split(/[,;:]|\s+y\s+/)[0].replace(/[.\s]+$/, '').trim();
    if (!head || head.length > 40 || NOT_A_TOPIC_RE.test(head)) continue;
    if (normTokens(head).some((w) => exclude.some((e) => same(w, e)))) continue;
    const t = head.charAt(0).toLowerCase() + head.slice(1);
    if (!out.includes(t)) out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}
const listText = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);

/**
 * ¿El resultado dice QUÉ se aprende? Uno con un solo término sustantivo después del verbo («Reconocer vocabulario
 * fundamental», «Comprender textos cortos») tiene intención clara pero no dice qué vocabulario ni qué textos: Cursia lo
 * precisa (idioma del curso + temas de sus unidades). Devuelve el texto precisado o null si no hace falta / no hay contexto.
 */
export function improvedOutcomeText(text: string, ctx: AcademicContextV1 | null | undefined, courseName?: string | null): string | null {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
  const words = t.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 6) return null;
  const toks = normTokens(t);
  if (!(toks.length > 1 && VERB_RE.test(toks[0]))) return null; // sin verbo inicial: no es un resultado que se pueda precisar
  if (contentTokens(t, VAGUE).length > 1) return null;
  const lang = courseLanguage(ctx, courseName);
  const mentionsLang = !!lang && stripToAscii(t).includes(stripToAscii(lang).split(' ')[0]);
  const topics = courseTopics(ctx, contentTokens(t, VAGUE));
  if (topics.length < 2 && !(lang && !mentionsLang)) return null;
  const parts = [t];
  if (lang && !mentionsLang) parts.push(`en ${lang}`);
  if (topics.length >= 2) parts.push(`sobre ${listText(topics)}`);
  const out = parts.join(' ');
  return out.length <= 220 ? out : null;
}

const DEEPENING_RE = /^profundizaci[oó]n\b/i;
const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Cuántos capítulos recibe, como máximo, un resultado transversal (los de relación más fuerte). */
const MAX_TRANSVERSAL = 3;

export function planAutofix(input: AutofixInput): AutofixPlan {
  const changes: AutofixChange[] = [];
  const proposals: AutofixProposal[] = [];
  const suggestions: AutofixPlan['suggestions'] = {};
  const declined = input.declined || new Set<string>();
  const ctx = input.ctx;
  const mods = [...input.modules].sort((a, b) => a.position - b.position);
  const modPos = new Map(mods.map((m, i) => [m.id, i]));
  const chs = [...input.chapters].sort((a, b) => (modPos.get(a.moduleId) ?? 0) - (modPos.get(b.moduleId) ?? 0) || a.position - b.position);
  const order = new Map(chs.map((c, i) => [c.id, i]));
  const modOf = new Map(mods.map((m) => [m.id, m]));
  const after = new Map<string, string[]>(); // vínculos nuevos de esta corrección
  const linksOf = (c: AutofixChapter) => after.get(c.id) || c.outcomeIds;
  const eligible = (c: AutofixChapter) => c.kind === 'content' && !c.noLinks && !c.outcomeIds.length && !after.has(c.id);
  const coveredIds = () => new Set(chs.flatMap((c) => linksOf(c)));
  const set = (c: AutofixChapter, kind: AutofixKind, id: string, ids: string[], title: string, reason: string) => {
    const prev = [...linksOf(c)];
    const next = sortOutcomeIds([...new Set([...prev, ...ids])]);
    after.set(c.id, next);
    const m = modOf.get(c.moduleId);
    const added = next.filter((x) => !prev.includes(x));
    changes.push({ id, kind, origin: AUTOFIX_ORIGIN, title, reason, target: { chapterId: c.id, chapterTitle: c.title, moduleTitle: m ? m.title : undefined, outcomeIds: next }, before: prev, after: next, added });
  };

  if (ctx) {
    const known = new Set([...ctx.outcomes.map((o) => o.id), ...ctx.competencies.map((c) => c.id)]);
    const courseName = input.course ? input.course.name : null;
    // 0 · r72 · Resultados del documento con intención clara pero sin decir QUÉ (se precisan; el original se conserva).
    for (const o of ctx.outcomes) {
      if (o.status === 'provided') continue; // lo que escribió el docente es suyo
      const key = `wording:${o.id}`;
      if (declined.has(key)) continue;
      const better = improvedOutcomeText(o.text, ctx, courseName);
      if (!better || better === o.text) continue;
      const what = contentTokens(o.text, VAGUE).join(' ');
      changes.push({ id: key, kind: 'outcome_wording', origin: AUTOFIX_ORIGIN, title: `${o.id} con una redacción más precisa: «${short(better, 110)}»`,
        reason: `«${o.text}» tiene una intención clara, pero no decía ${what ? `qué ${what}` : 'qué se aprende'} ni en qué contexto. Cursia lo precisó con ${[courseLanguage(ctx, courseName) ? 'el idioma del curso' : '', 'los temas de las unidades del documento'].filter(Boolean).join(' y ')}, sin cambiar el verbo ni la intención. El texto original queda guardado.`,
        target: { outcomeId: o.id }, before: o.text, after: better });
    }

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
    const addable = (c: AutofixChapter) => c.kind === 'content' && !c.noLinks && !declined.has(`chapter:${c.id}`);
    for (const o of ctx.outcomes) {
      if (coveredIds().has(o.id)) continue;
      const scored = mods.map((m) => ({ m, r: relation(o.text, chText.get(m.id) || '', modText.get(m.id) || '', courseWide) })).sort((a, b) => b.r.score - a.r.score || (modPos.get(a.m.id)! - modPos.get(b.m.id)!));
      const best = scored[0];
      const second = scored[1];
      const plausible = !!best && (best.r.score >= 2 || (best.r.score >= 1 && (!second || second.r.score < best.r.score)));
      const why = best ? whyOf(best.r) : '';
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
      // r72 · Sin capítulo libre: el resultado es transversal. Se AGREGA a los capítulos de contenido que lo trabajan con
      // evidencia (relación ≥ 2 con el capítulo y su módulo: términos o familias de conceptos), sin quitar nada.
      if (!target && !declined.has(key)) {
        const perChapter = chs.filter(addable).map((c) => ({ c, r: relation(o.text, textOf(c), modText.get(c.moduleId) || '', courseWide, 2) }))
          .filter((x) => x.r.score >= 2).sort((a, b) => b.r.score - a.r.score || order.get(a.c.id)! - order.get(b.c.id)!).slice(0, MAX_TRANSVERSAL)
          .sort((a, b) => order.get(a.c.id)! - order.get(b.c.id)!);
        const open = perChapter.filter((x) => !declined.has(`${key}@${x.c.id}`));
        for (const x of open) {
          const m = modOf.get(x.c.moduleId);
          set(x.c, 'cover_outcome', `${key}@${x.c.id}`, [o.id], `${o.id} también se trabaja en «${short(x.c.title)}»`,
            `${o.id} («${short(o.text, 90)}») no estaba en ningún capítulo y es transversal: este capítulo${m ? ` (módulo «${m.title}»)` : ''} lo desarrolla (${whyOf(x.r)}). Se agregó a sus resultados; los que tenía siguen igual.`);
        }
        if (open.length) { suggestions[o.id] = { chapterId: open[0].c.id, chapterTitle: open[0].c.title }; continue; }
      }
      const sug = suggestions[o.id];
      if (!plausible && !declined.has(key)) {
        // r72 · Sin ninguna relación: un vínculo sería inventado. Se propone un AJUSTE DE CONTENIDO: agregar el tema del
        // resultado al capítulo de contenido más cercano (o al último del curso), que decide el docente con un clic.
        const near = chs.filter(addable).map((c) => ({ c, s: relation(o.text, textOf(c), modText.get(c.moduleId) || '', new Set()).score }))
          .sort((a, b) => b.s - a.s || order.get(b.c.id)! - order.get(a.c.id)!)[0];
        const topic = outcomeTopic(o.text);
        if (near && topic) {
          proposals.push({ id: `content:${o.id}`, kind: 'content_adjustment', outcomeId: o.id, chapterId: near.c.id, chapterTitle: near.c.title, topic,
            title: `${o.id} («${short(o.text, 90)}») no lo trabaja ningún capítulo.`,
            detail: `Ningún capítulo trata este tema, así que Cursia no lo vincula a la fuerza. Propone agregar «${topic}» a «${short(near.c.title)}» y vincular ${o.id} ahí. Tú decides: acepta, elige otro capítulo o agrega uno nuevo.` });
          continue;
        }
      }
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
      if (!mod) continue;
      const outs = sortOutcomeIds([...new Set((contentByModule.get(c.moduleId) || []).filter((x) => x.id !== c.id).flatMap((x) => x.outcomeIds))]).filter((x) => known.has(x) && !x.startsWith('CO'));
      if (outs.length) {
        set(c, 'chapter_outcomes', key, outs, `«${short(c.title)}» → ${outs.join(', ')}`,
          deepening ? `Profundiza el módulo «${mod.title}»: trabaja los resultados de ese módulo.` : `El documento no le asigna un resultado propio: trabaja los resultados de su módulo «${mod.title}».`);
        continue;
      }
      // r72 · Módulo sin ningún resultado (p. ej. un capítulo por unidad): los resultados con los que el capítulo y su
      // módulo comparten términos o familias (relación ≥ 2), como máximo 2. Sin relación, queda para revisión.
      if (!input.hasDocument) continue;
      const rel = ctx.outcomes.map((o) => ({ o, r: relation(o.text, textOf(c), modText.get(c.moduleId) || '', new Set(), 2) }))
        .filter((x) => x.r.score >= 2).sort((a, b) => b.r.score - a.r.score).slice(0, 2);
      if (!rel.length) continue;
      const ids = sortOutcomeIds(rel.map((x) => x.o.id));
      set(c, 'chapter_outcomes', key, ids, `«${short(c.title)}» → ${ids.join(', ')}`,
        `Su módulo «${mod.title}» no tenía resultados asociados. El capítulo trabaja ${rel.map((x) => `${x.o.id} (${whyOf(x.r)})`).join(' y ')}.`);
    }

    // 4 · Competencias sin capítulo.
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
      // r72: el camino «capítulo que integra sus resultados» es para un curso SIN prácticas integradoras; si las hay y el
      // docente deshizo esa mejora, no se busca otro lugar (queda como propuesta: decide él).
      const hasPractice = chs.some((c) => c.kind === 'practice');
      if (!practices.length) {
        for (const co of comps) {
          if (hasPractice) {
            proposals.push({ id: `competency:${co.id}`, kind: 'competency', outcomeId: co.id, chapterId: null, chapterTitle: null,
              title: `La competencia ${co.id} no está vinculada a ningún capítulo.`,
              detail: 'Vincúlala a los capítulos o Actividades de Aplicación donde se pone en juego.' });
            continue;
          }
          // r72 · Los resultados que la competencia agrupa: los que comparten términos o familias con ella (la única
          // competencia del curso agrupa todos). Se agrega al capítulo de cada módulo que integra más de ellos.
          const grouped = ctx.competencies.length === 1 ? ctx.outcomes.map((o) => o.id)
            : ctx.outcomes.filter((o) => relation(o.text, co.text, '', new Set()).score >= 1).map((o) => o.id);
          const picks: { c: AutofixChapter; n: string[] }[] = [];
          for (const m of mods) {
            const cands = (contentByModule.get(m.id) || []).filter((c) => !c.noLinks && !declined.has(`competency:${co.id}@${c.id}`) && !declined.has(`chapter:${c.id}`))
              .map((c) => ({ c, n: linksOf(c).filter((x) => grouped.includes(x)) })).filter((x) => x.n.length)
              .sort((a, b) => b.n.length - a.n.length || b.c.position - a.c.position);
            if (cands[0]) picks.push(cands[0]);
          }
          if (picks.length && !declined.has(`competency:${co.id}`)) {
            for (const x of picks) {
              set(x.c, 'competency', `competency:${co.id}@${x.c.id}`, [co.id], `«${short(x.c.title)}» desarrolla ${co.id}`,
                `${co.id} («${short(co.text, 70)}») agrupa ${ctx.competencies.length === 1 ? 'todos los resultados del curso' : `los resultados ${sortOutcomeIds(grouped).join(', ')}`}; este capítulo trabaja ${sortOutcomeIds(x.n).join(', ')} y es el que más los integra en su módulo. Se agregó ${co.id}; los resultados que tenía siguen igual.`);
            }
            continue;
          }
          proposals.push({ id: `competency:${co.id}`, kind: 'competency', outcomeId: co.id, chapterId: null, chapterTitle: null,
            title: `La competencia ${co.id} no está vinculada a ningún capítulo.`,
            detail: 'Ningún capítulo trabaja los resultados que agrupa. Vincúlala a los capítulos o Actividades de Aplicación donde se pone en juego.' });
        }
      }
    } else if (!ctx.competencies.length && ctx.outcomes.length && input.hasDocument) {
      // r72 · Curso con documento y sin competencias: propuesta revisable (nunca se guarda sola) a partir del objetivo del
      // documento o, si no hay, de la asignatura y sus resultados. No se inventa nada que el curso no diga.
      const text = proposedCompetency(ctx, courseName);
      if (text && !declined.has('competency:new')) {
        proposals.push({ id: 'competency:new', kind: 'missing_competency', outcomeId: 'CO1', chapterId: null, chapterTitle: null, text,
          title: 'El curso no tiene una competencia declarada.',
          detail: `Cursia propone esta, a partir de ${ctx.identity.generalObjective && ctx.identity.generalObjective.status !== 'missing' ? 'el objetivo general del documento' : 'la asignatura y sus resultados'}. Revísala antes de usarla.` });
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

/** r72 · El tema de un resultado (lo que va después del verbo), para proponer agregarlo a un capítulo. */
export function outcomeTopic(text: string): string | null {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
  const words = t.split(' ');
  const isVerb = (w: string) => VERB_RE.test(normTokens(w)[0] || '');
  // Sin los verbos del inicio («Formular y responder preguntas básicas» → «preguntas básicas»).
  let i = 0;
  if (words.length > 1 && isVerb(words[0])) {
    i = 1;
    while (i + 1 < words.length && /^(y|e|o|u)$/i.test(words[i]) && isVerb(words[i + 1])) i += 2;
  }
  const rest = words.slice(i).join(' ') || t;
  const topic = rest.charAt(0).toUpperCase() + rest.slice(1);
  return topic.length >= 4 ? short(topic, 120) : null;
}

/** r72 · Competencia propuesta: el objetivo general del documento si existe; si no, la asignatura y sus resultados. */
export function proposedCompetency(ctx: AcademicContextV1, courseName?: string | null): string | null {
  const go = ctx.identity && ctx.identity.generalObjective;
  if (go && go.status !== 'missing' && go.value && String(go.value).trim().length >= 20) return short(String(go.value).replace(/\s+/g, ' ').trim(), 480);
  const subject = ctx.identity && ctx.identity.subjectName && ctx.identity.subjectName.status !== 'missing' ? String(ctx.identity.subjectName.value || '') : String(courseName || '');
  const verbs = ctx.outcomes.slice(0, 3).map((o) => o.text.replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '')).map((t) => t.charAt(0).toLowerCase() + t.slice(1));
  if (!subject || !verbs.length) return null;
  return short(`Aplicar lo aprendido en «${subject}» para ${listText(verbs)}, en situaciones propias del curso.`, 480);
}

// ── Registro (courses.metadata.pedagogicalAutofix) ───────────────────────────────────────────────────────────────

export interface AutofixRecord extends AutofixChange {
  batchId: string;
  at: string;
  /**
   * superseded = el docente lo cambió después (o escribió el dato): es decisión suya, Cursia no lo vuelve a tocar.
   * r72 · obsolete = lo que cambió ya no existe (p. ej. la estructura se reemplazó): no se muestra como aplicado ni cuenta
   * como decisión del docente (si vuelve a hacer falta, Cursia lo vuelve a corregir).
   */
  status: 'applied' | 'reverted' | 'superseded' | 'obsolete';
  revertedAt?: string;
  /** r72 · outcome_wording: el resultado tal como estaba (texto, origen y cita del documento) para «Deshacer». */
  beforeOutcome?: unknown;
  /** r72 · content_adjustment: la descripción del capítulo antes de agregar el tema. */
  beforeDescription?: string | null;
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

/** Lo que sigue aplicado (el último registro de cada cambio es «aplicado»), en el orden en que se aplicó. */
export function appliedRecords(state: AutofixState): AutofixRecord[] {
  const last = new Map<string, AutofixRecord>();
  for (const c of state.changes) { last.delete(c.id); last.set(c.id, c); }
  return [...last.values()].filter((c) => c.status === 'applied');
}

/** Vínculos que agregó un cambio de capítulo (los registros de r71 no los guardan: after − before). */
export function addedLinks(r: { added?: string[]; before: unknown; after: unknown }): string[] {
  if (Array.isArray(r.added)) return r.added.map(String);
  const before = Array.isArray(r.before) ? (r.before as string[]) : [];
  return Array.isArray(r.after) ? (r.after as string[]).filter((x) => !before.includes(x)) : [];
}

/**
 * r72 · El registro frente a lo que hay HOY: cada cambio aplicado cuyo capítulo ya no existe queda «obsolete» (la
 * estructura se reemplazó: no es una decisión del docente y no se muestra como mejora vigente); el que el docente cambió
 * después (quitó un vínculo que agregó Cursia, editó el resultado o el dato) queda «superseded». Puro: no escribe.
 */
export function liveAutofixState(state: AutofixState, view: { chapters: ReadonlyMap<string, string[]>; sector?: string | null; outcomes?: ReadonlyMap<string, string> | null }): AutofixState {
  const extra: AutofixRecord[] = [];
  for (const r of appliedRecords(state)) {
    if (r.target && r.target.chapterId) {
      const cur = view.chapters.get(r.target.chapterId);
      if (!cur) { extra.push({ ...r, status: 'obsolete' }); continue; }
      if (!addedLinks(r).every((x) => cur.includes(x))) extra.push({ ...r, status: 'superseded' });
    } else if (r.kind === 'context_field' && r.target && r.target.field === 'sector' && view.sector !== undefined) {
      if (view.sector !== r.after) extra.push({ ...r, status: 'superseded' });
    } else if (r.kind === 'outcome_wording' && r.target && r.target.outcomeId && view.outcomes) {
      const cur = view.outcomes.get(r.target.outcomeId);
      if (cur === undefined) extra.push({ ...r, status: 'obsolete' });
      else if (cur !== r.after) extra.push({ ...r, status: 'superseded' });
    } else if (r.kind === 'competency_added' && r.target && r.target.outcomeId && view.outcomes) {
      if (!view.outcomes.has(r.target.outcomeId)) extra.push({ ...r, status: 'superseded' });
    }
  }
  return extra.length ? { ...state, changes: [...state.changes, ...extra] } : state;
}

/** Lo que el docente deshizo (no se vuelve a aplicar). Un cambio aplicado otra vez después de deshacerse ya no cuenta. */
export function declinedKeys(state: AutofixState): Set<string> {
  const last = new Map<string, AutofixRecord>();
  for (const c of state.changes) last.set(c.id, c);
  const out = new Set<string>();
  for (const c of last.values()) {
    if (c.status !== 'reverted' && c.status !== 'superseded') continue;
    out.add(c.id);
    // r72 · Un vínculo transversal deshecho en UN capítulo («cover:RA1@<cap>», «competency:CO1@<cap>») cuenta para ese
    // vínculo, no para todo el capítulo (los demás resultados del capítulo siguen siendo de Cursia o del documento).
    if (c.id.includes('@')) continue;
    // Un capítulo cuyo cambio se deshizo queda como lo dejó el docente: ningún otro paso lo vuelve a tocar.
    if (c.target && c.target.chapterId) { out.add(`chapter:${c.target.chapterId}`); out.add(`competency:${c.target.chapterId}`); }
  }
  return out;
}

// ── r72 · Preguntas cortas y el diseño recomendado sin aplicar ──────────────────────────────────────────────────

export interface CourseQuestion {
  /** Dato que responde (acción context_field con este field). */
  key: 'priorKnowledge';
  question: string;
  options: { value: string; label: string }[];
  /** Respuesta que sugiere Cursia (preseleccionada; el docente decide). */
  suggestion: string | null;
  /** Por qué sugiere eso (la evidencia del curso). */
  why: string | null;
}

export const PRIOR_KNOWLEDGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'none', label: 'Sin conocimientos previos' },
  { value: 'basic', label: 'Conoce lo esencial del tema' },
  { value: 'intermediate', label: 'Conoce los conceptos fundamentales' },
  { value: 'advanced', label: 'Ya trabaja en el área' },
];

/**
 * r72 · «¿Qué sabe ya el estudiante?»: UNA pregunta en la misma pantalla, con la sugerencia que se deduce del curso (el
 * nivel del pedido, el nombre del curso, el nivel educativo del documento). Nunca se guarda sola: la decide el docente.
 */
export function priorKnowledgeQuestion(f: { courseName: string | null; suggestion: string | null; briefLevel: string | null; educationLevel: string | null }): CourseQuestion {
  const name = (f.courseName || '').trim();
  const valid = PRIOR_KNOWLEDGE_OPTIONS.some((o) => o.value === f.suggestion) ? f.suggestion : null;
  const fromName = /\b(b[aá]sico|inicial|introducci[oó]n|fundamentos|principiantes?|desde cero)\b/i.test(name) ? 'none' : null;
  const suggestion = valid || fromName;
  const ev: string[] = [];
  if (name && fromName) ev.push(`el curso es «${name}»`);
  if (f.educationLevel) ev.push(`el documento indica «${f.educationLevel}»`);
  if (f.briefLevel && valid) ev.push(`el pedido dice «${f.briefLevel}»`);
  const label = suggestion ? (PRIOR_KNOWLEDGE_OPTIONS.find((o) => o.value === suggestion) || { label: '' }).label : '';
  return {
    key: 'priorKnowledge',
    question: name ? `¿Qué sabe ya el estudiante al empezar «${name}»?` : '¿Qué sabe ya el estudiante al empezar el curso?',
    options: PRIOR_KNOWLEDGE_OPTIONS,
    suggestion,
    why: suggestion ? `Cursia sugiere «${label}»${ev.length ? ` porque ${listText(ev)}` : ''}. La apertura de cada módulo se apoya en esto.` : 'La apertura de cada módulo se apoya en lo que el estudiante ya sabe.',
  };
}

/** r72 · Resumen, para el docente, de los cambios del diseño recomendado que todavía no se aplicaron. */
export function designChangesSummary(changes: { type: string; subtopics?: string[] }[], hours: { target: number | null; estimated: number | null }): string[] {
  const n = (t: string) => changes.filter((c) => c.type === t).length;
  const out: string[] = [];
  const add = (k: number, one: string, many: string) => { if (k) out.push(`${k} ${k === 1 ? one : many}`); };
  // r80: los capítulos que salen de los subtemas del documento no son «profundización».
  const fromSubtopics = changes.filter((c) => c.type === 'add_content_chapter' && Array.isArray(c.subtopics)).length;
  add(fromSubtopics, 'capítulo nuevo con subtemas del documento', 'capítulos nuevos con subtemas del documento');
  add(n('add_content_chapter') - fromSubtopics, 'capítulo de profundización', 'capítulos de profundización');
  // r80: un capítulo existente que se reparte en subtemas cambia de título (su contenido ya generado queda desactualizado).
  add(n('split_content_chapter'), 'capítulo actual que cambia de título al repartir sus subtemas', 'capítulos actuales que cambian de título al repartir sus subtemas');
  add(n('add_practice_chapter'), 'capítulo de práctica', 'capítulos de práctica');
  add(n('set_application_activity'), 'Actividad de Aplicación', 'Actividades de Aplicación');
  add(n('set_guided_practice'), 'ejercicio guiado', 'ejercicios guiados');
  add(n('set_video') + n('set_activity') + n('remove_application_activity') + n('remove_guided_practice'), 'ajuste de video o actividad', 'ajustes de video o actividades');
  if (out.length && typeof hours.target === 'number') out.push(`para llegar a las ${String(hours.target).replace('.', ',')} h de trabajo del estudiante${typeof hours.estimated === 'number' ? ` (≈ ${String(Math.round(hours.estimated * 10) / 10).replace('.', ',')} h con el diseño)` : ''}`);
  return out;
}
