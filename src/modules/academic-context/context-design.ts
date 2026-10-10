import { tokenContainment, tokenJaccard } from '../coherence/normalize';
import { STRUCTURE_TITLE_MAX, normalizeStructureTitle } from '../course-structure/structure-titles';
import {
  MAX_LIST_ITEMS,
  MAX_TEXT_LENGTH,
  PedagogicalProfile,
  emptyPedagogicalProfile,
  normalizePedagogicalProfile,
} from '../pedagogy/pedagogy-profile';
import { DISTRIBUTOR_RULES } from '../study-time/distributor';
import { isValidTargetHours } from '../study-time/target-hours';
import { ASSESSMENT_METHODS, AssessmentMethod } from '../pedagogy/vocabulary';
import type { AcademicContextV1, FieldStatus, ThematicUnit, UnitContent } from './academic-context';

/**
 * Fase 3 · Loop 3.5 — Contexto académico → diseño (puro, determinista, sin proveedores).
 *
 *   1. suggestProfileFromContext — qué campos del perfil pedagógico salen del contexto (estudiante, nivel,
 *      resultados saber / saber hacer, competencias, horas objetivo, métodos de evaluación), con su procedencia.
 *      El docente lo aplica con «Usar en el perfil»: desde ahí TODO el motor existente (reglas pedagógicas,
 *      distribuidor, Actividades de Aplicación) usa esos datos sin cambios.
 *   2. proposeStructureFromContext — unidades → módulos, contenidos → capítulos (≤ 5 por módulo, agrupados en orden),
 *      objetivo del módulo = sus resultados, descripción del capítulo = los contenidos que cubre, y los vínculos
 *      capítulo → resultados (del documento si los trae; si no, por coincidencia de términos, marcados «inferred»).
 *   3. suggestOutcomeLinks — para una estructura que ya existe: qué resultados encajan en cada capítulo.
 *
 * Nada se inventa: sin unidades no hay propuesta; un título nunca se trunca con «…» (el detalle va a la
 * descripción); un capítulo sin coincidencia queda sin vínculos.
 */

export const CONTEXT_DESIGN_VERSION = 1 as const;

// ── 1. Perfil pedagógico ──────────────────────────────────────────────────────────────────────────────────

export interface ProfileSuggestionChange {
  path: string;
  /** Lo que el perfil tenía antes (null = vacío). */
  from: unknown;
  to: unknown;
  /** Estado del dato en el contexto (found / inferred / provided). */
  source: Exclude<FieldStatus, 'missing'>;
}

export interface ProfileSuggestion {
  profile: PedagogicalProfile;
  changes: ProfileSuggestionChange[];
  notes: string[];
  /** Enfoques que la metodología del documento nombra (pista para «Cursia recomienda»; nunca se aplica solo). */
  approachHints: string[];
}

const ASSESSMENT_HINTS: ReadonlyArray<[AssessmentMethod, RegExp]> = [
  ['quizzes', /\b(examen|examenes|quiz|parcial(es)?|prueba(s)? (escrita|objetiva)|cuestionario|test)\b/],
  ['practical_exercises', /\b(taller(es)?|ejercicio(s)?|practica(s)?|laboratorio(s)?|simulacion(es)?)\b/],
  ['cases', /\b(caso(s)?|estudio de caso)\b/],
  ['projects', /\b(proyecto(s)?)\b/],
  ['products_evidence', /\b(informe(s)?|producto(s)?|portafolio|evidencia(s)?|entregable(s)?|ensayo(s)?)\b/],
  ['self_reflection', /\b(autoevaluacion|reflexion|diario)\b/],
  ['peer', /\b(coevaluacion|evaluacion (entre|de) pares|pares)\b/],
];
const APPROACH_HINTS: ReadonlyArray<[string, RegExp]> = [
  ['problemas', /aprendizaje basado en problemas|\babp\b|resolucion de problemas/],
  ['competencias', /basad[oa] en competencias|enfoque (por|de|basado en) competencias|formacion por competencias/],
  ['experiencial', /aprendizaje experiencial|aprender haciendo/],
  ['significativo', /aprendizaje significativo/],
  ['autodirigido', /aprendizaje autodirigido|autoaprendizaje|aprendizaje autonomo/],
];
/**
 * Review LOOP 9.2 (I7): enfoque NOMBRADO por la metodología («aprendizaje basado en problemas», «enfoque por
 * competencias»…) frente a una práctica que solo lo sugiere («razonamiento sobre casos», «centrada en situaciones»).
 * «autoaprendizaje» describe la modalidad, no el enfoque: no cuenta como enfoque nombrado.
 */
const APPROACH_STRONG: ReadonlyArray<[string, RegExp]> = [
  ['problemas', /aprendizaje basado en problemas|\babp\b/],
  ['competencias', /basad[oa] en competencias|enfoque (por|de|basado en) competencias|formacion por competencias/],
  ['experiencial', /aprendizaje experiencial/],
  ['significativo', /aprendizaje significativo/],
  ['autodirigido', /aprendizaje autodirigido/],
];
const APPROACH_WEAK: ReadonlyArray<[string, RegExp]> = [
  ['problemas', /resolucion de problemas|razonamiento sobre casos|basad[oa] en casos|centrad[oa] en (situaciones|casos)/],
];

/**
 * LOOP 9.2 · Enfoque que indica la metodología del documento: el nombrado (el primero que aparece en el texto) con
 * confianza alta; si no nombra ninguno, el que sugiere su práctica (casos → ABP) con confianza media; si no, null.
 */
export function approachFromMethodology(text: string | null | undefined): { id: string; strong: boolean } | null {
  if (!text) return null;
  const p = plain(text);
  const strong = APPROACH_STRONG.map(([id, re]) => ({ id, at: p.search(re) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  if (strong.length) return { id: strong[0].id, strong: true };
  const weak = APPROACH_WEAK.find(([, re]) => re.test(p));
  return weak ? { id: weak[0], strong: false } : null;
}

const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);

/**
 * Perfil pedagógico con los datos del contexto aplicados sobre `current` (o un perfil vacío). Solo pisa los campos
 * que el contexto conoce; enfoque, formas de aprender, principios y preferencias del docente se conservan.
 */
export function suggestProfileFromContext(ctx: AcademicContextV1, current: PedagogicalProfile | null): ProfileSuggestion {
  const base: PedagogicalProfile = current ? JSON.parse(JSON.stringify(current)) : emptyPedagogicalProfile();
  const changes: ProfileSuggestionChange[] = [];
  const notes: string[] = [];
  const set = (path: string, from: unknown, to: unknown, source: Exclude<FieldStatus, 'missing'>, apply: () => void) => {
    if (JSON.stringify(from) === JSON.stringify(to)) return;
    apply();
    changes.push({ path, from, to, source });
  };

  const lp = ctx.learner.profile;
  if (lp.status !== 'missing' && lp.value) {
    const v = clip(lp.value, MAX_TEXT_LENGTH);
    set('learner.description', base.learner.description, v, lp.status, () => { base.learner.description = v; });
  }
  const lv = ctx.identity.educationLevel;
  if (lv.status !== 'missing' && lv.value?.level) {
    const v = lv.value.level;
    set('learner.educationLevel', base.learner.educationLevel, v, lv.status, () => { base.learner.educationLevel = v; });
  }
  const pick = (xs: { text: string; status: Exclude<FieldStatus, 'missing'> }[], what: string) => {
    if (xs.length > MAX_LIST_ITEMS) notes.push(`El contexto trae ${xs.length} ${what}; el perfil admite ${MAX_LIST_ITEMS}: se usaron los primeros.`);
    return xs.slice(0, MAX_LIST_ITEMS).map((x) => clip(x.text, MAX_TEXT_LENGTH));
  };
  const statusOf = (xs: { status: Exclude<FieldStatus, 'missing'> }[]): Exclude<FieldStatus, 'missing'> =>
    xs.some((x) => x.status === 'inferred') ? 'inferred' : xs.every((x) => x.status === 'provided') ? 'provided' : 'found';
  const know = ctx.outcomes.filter((o) => o.domain === 'know');
  const doo = ctx.outcomes.filter((o) => o.domain === 'do');
  if (know.length) set('learningOutcomes.know', base.learningOutcomes.know, pick(know, 'resultados de saber'), statusOf(know), () => { base.learningOutcomes.know = pick(know, 'resultados de saber'); });
  if (doo.length) set('learningOutcomes.do', base.learningOutcomes.do, pick(doo, 'resultados de saber hacer'), statusOf(doo), () => { base.learningOutcomes.do = pick(doo, 'resultados de saber hacer'); });
  if (ctx.competencies.length) {
    set('learningOutcomes.competencies', base.learningOutcomes.competencies, pick(ctx.competencies, 'competencias'), statusOf(ctx.competencies), () => { base.learningOutcomes.competencies = pick(ctx.competencies, 'competencias'); });
  }
  const t = ctx.hours.total;
  if (t.status !== 'missing' && t.value !== null) {
    if (isValidTargetHours(t.value)) set('targetHours', base.targetHours ?? null, t.value, t.status, () => { base.targetHours = t.value as number; });
    else notes.push(`El total de ${t.value} horas no es una carga horaria objetivo válida (1–500 en pasos de 0,5): no se aplicó.`);
  }
  const methods = new Set<AssessmentMethod>(base.assessmentMethods);
  for (const e of ctx.evaluation) {
    const p = plain(e.instrument);
    for (const [m, re] of ASSESSMENT_HINTS) if (re.test(p)) methods.add(m);
  }
  const nextMethods = ASSESSMENT_METHODS.filter((x) => methods.has(x));
  if (ctx.evaluation.length) set('assessmentMethods', base.assessmentMethods, nextMethods, statusOf(ctx.evaluation), () => { base.assessmentMethods = nextMethods; });

  const approachHints: string[] = [];
  const m = ctx.methodology;
  if (m.status !== 'missing' && m.value) {
    const p = plain(m.value);
    for (const [id, re] of APPROACH_HINTS) if (re.test(p)) approachHints.push(id);
  }
  // Valida y canonicaliza (orden del vocabulario, textos colapsados); un perfil inválido nunca sale de aquí.
  const profile = normalizePedagogicalProfile(base);
  return { profile, changes, notes, approachHints };
}

// ── 2. Propuesta de estructura ─────────────────────────────────────────────────────────────────────────────

export type LinkStatus = 'found' | 'inferred' | 'none';

export interface ContextChapterProposal {
  title: string;
  objective: string | null;
  description: string | null;
  videoEnabled: boolean;
  activityEnabled: boolean;
  outcomeIds: string[];
  linkStatus: LinkStatus;
  sourceContentIds: string[];
}

export interface ContextModuleProposal {
  title: string;
  objective: string | null;
  description: string | null;
  examEnabled: boolean;
  outcomeIds: string[];
  sourceUnitId: string;
  chapters: ContextChapterProposal[];
}

export interface ContextStructureProposal {
  contextDesignVersion: typeof CONTEXT_DESIGN_VERSION;
  available: boolean;
  /** Motivo si no hay propuesta (sin unidades / sin contenidos). */
  reason: string | null;
  modules: ContextModuleProposal[];
  finalExam: boolean;
  notes: string[];
  counts: { modules: number; chapters: number; linkedChapters: number; inferredLinks: number; outcomesCovered: number; outcomesTotal: number };
}

/** Coincidencia léxica mínima para inferir un vínculo contenido → resultado (contención de tokens del contenido). */
export const LINK_CONTAINMENT_MIN = 0.5;
export const LINK_JACCARD_MIN = 0.2;

/** Resultados cuyo texto comparte términos con `text` (inferido). Orden: mejor coincidencia primero, máx. 3. */
export function lexicalOutcomeMatches(text: string, outcomes: { id: string; text: string }[]): string[] {
  const scored = outcomes
    .map((o) => ({ id: o.id, c: tokenContainment(text, o.text), j: tokenJaccard(text, o.text) }))
    .filter((x) => x.c >= LINK_CONTAINMENT_MIN || x.j >= LINK_JACCARD_MIN)
    .sort((a, b) => b.c - a.c || b.j - a.j || (a.id < b.id ? -1 : 1));
  return scored.slice(0, 3).map((x) => x.id);
}

function titleAndRest(raw: string): { title: string; rest: string | null } {
  const split = normalizeStructureTitle(raw, STRUCTURE_TITLE_MAX);
  if (split) return { title: split.title, rest: split.description };
  // Sin una separación clara: el título es la primera cláusula que entra; el texto completo va a la descripción.
  const cut = raw.slice(0, STRUCTURE_TITLE_MAX);
  const at = Math.max(cut.lastIndexOf(':'), cut.lastIndexOf(','), cut.lastIndexOf(' ('));
  const title = (at > 20 ? cut.slice(0, at) : cut.replace(/\s+\S*$/, '')).trim();
  return { title, rest: raw };
}

/** Reparte n elementos en k grupos consecutivos lo más parejos posible (los primeros grupos, uno más). */
function chunk<T>(xs: T[], k: number): T[][] {
  const out: T[][] = [];
  const base = Math.floor(xs.length / k);
  let extra = xs.length % k;
  let i = 0;
  for (let g = 0; g < k; g++) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    out.push(xs.slice(i, i + size));
    i += size;
  }
  return out.filter((g) => g.length);
}


type OutcomeRef = { id: string; text: string };

/** Un capítulo con un grupo de contenidos del documento (sus vínculos: los del contenido, los de la unidad o por términos). */
function chapterFromContents(g: UnitContent[], unitLinks: string[], outcomes: OutcomeRef[], raOnly: OutcomeRef[], title: (t: string) => string): ContextChapterProposal {
  const docLinks = [...new Set(g.flatMap((c) => c.outcomeIds))];
  let outcomeIds = docLinks;
  let linkStatus: LinkStatus = docLinks.length ? 'found' : 'none';
  if (!outcomeIds.length && unitLinks.length) {
    // La unidad vincula resultados: cada capítulo toma los que mejor le encajan (o todos, si ninguno destaca).
    const candidates = outcomes.filter((o) => unitLinks.includes(o.id));
    const lex = lexicalOutcomeMatches(g.map((c) => c.text).join(' '), candidates);
    // Todos los de la unidad = lo que dice el documento (found); un subconjunto elegido por términos = inferred.
    outcomeIds = lex.length && lex.length < unitLinks.length ? lex : [...unitLinks];
    linkStatus = outcomeIds.length < unitLinks.length ? 'inferred' : 'found';
  }
  if (!outcomeIds.length && raOnly.length) {
    outcomeIds = lexicalOutcomeMatches(g.map((c) => c.text).join(' '), raOnly);
    linkStatus = outcomeIds.length ? 'inferred' : 'none';
  }
  const first = titleAndRest(g[0].text);
  const description = g.length > 1 ? g.map((c) => c.text).join('; ') : first.rest;
  return {
    title: title(first.title),
    objective: null,
    description: description ? clip(description, 2000) : null,
    videoEnabled: true,
    activityEnabled: true,
    outcomeIds: outcomeIds.slice(0, 8).sort(cmpOutcome),
    linkStatus,
    sourceContentIds: g.map((c) => c.id),
  };
}

export function proposeStructureFromContext(ctx: AcademicContextV1): ContextStructureProposal {
  const notes: string[] = [];
  const empty = (reason: string): ContextStructureProposal => ({
    contextDesignVersion: CONTEXT_DESIGN_VERSION, available: false, reason, modules: [], finalExam: true, notes,
    counts: { modules: 0, chapters: 0, linkedChapters: 0, inferredLinks: 0, outcomesCovered: 0, outcomesTotal: ctx.outcomes.length },
  });
  const units = ctx.units.filter((u) => u.contents.length > 0);
  if (!units.length) return empty(ctx.units.length ? 'Las unidades del documento no tienen contenidos.' : 'El documento no trae unidades ni contenidos para proponer la estructura.');
  if (units.length < ctx.units.length) notes.push(`${ctx.units.length - units.length} unidad(es) sin contenidos no se usaron.`);
  if (units.length === 1 && ctx.units[0].status === 'inferred') notes.push('El documento no agrupa los contenidos en unidades: se propone un solo módulo.');

  const outcomes = [...ctx.outcomes.map((o) => ({ id: o.id, text: o.text })), ...ctx.competencies.map((c) => ({ id: c.id, text: c.text }))];
  const raOnly = ctx.outcomes.map((o) => ({ id: o.id, text: o.text }));
  const maxCh = DISTRIBUTOR_RULES.maxContentChaptersPerModule;
  const seenTitles = new Set<string>();
  const uniqueTitle = (t: string, fallbackSuffix: string) => {
    let title = t;
    if (seenTitles.has(title.toLowerCase())) title = `${t.slice(0, STRUCTURE_TITLE_MAX - fallbackSuffix.length - 3)} (${fallbackSuffix})`;
    seenTitles.add(title.toLowerCase());
    return title;
  };

  const modules: ContextModuleProposal[] = units.map((u: ThematicUnit) => {
    const groups = chunk(u.contents, Math.min(maxCh, u.contents.length));
    if (u.contents.length > maxCh) notes.push(`La unidad ${u.id} trae ${u.contents.length} contenidos: se agruparon en ${maxCh} capítulos (sin perder ninguno: cada capítulo lista los suyos).`);
    const unitLinks = u.outcomeIds;
    const chapters = groups.map((g, gi): ContextChapterProposal => chapterFromContents(g, unitLinks, outcomes, raOnly, (t) => uniqueTitle(t, `${u.id}.${gi + 1}`)));
    const modLinks = [...new Set([...unitLinks, ...chapters.flatMap((c) => c.outcomeIds)])].sort(cmpOutcome);
    const modOutcomeTexts = modLinks.map((id) => outcomes.find((o) => o.id === id)).filter((o): o is { id: string; text: string } => !!o && o.id.startsWith('RA'));
    const t = titleAndRest(u.title);
    return {
      title: uniqueTitle(t.title, u.id),
      // El objetivo del módulo SON sus resultados de aprendizaje (texto del documento, sin reescribir).
      objective: modOutcomeTexts.length ? clip(modOutcomeTexts.map((o) => o.text.replace(/\.$/, '')).join('; ') + '.', 1000) : null,
      description: t.rest ? clip(t.rest, 2000) : null,
      examEnabled: true,
      outcomeIds: modLinks,
      sourceUnitId: u.id,
      chapters,
    };
  });

  return finishContextProposal(ctx, modules, notes);
}

// ── 2b. Redistribución en otra forma (Fase 3) ─────────────────────────────────────────────────────────────────

/** Forma elegida: N módulos × M capítulos de contenido (las prácticas las agrega el diseño, no cuentan aquí). */
export interface StructureShape { modules: number; chaptersPerModule: number }
/** Validación de entrada (no es una capacidad: el editor no tiene máximo); evita pedidos absurdos a la API. */
export const SHAPE_INPUT_MAX = Object.freeze({ modules: 50, chaptersPerModule: 30 });

export function isValidShape(s: unknown): s is StructureShape {
  const o = s as StructureShape;
  return !!o && Number.isInteger(o.modules) && Number.isInteger(o.chaptersPerModule) && o.modules >= 1 && o.chaptersPerModule >= 1
    && o.modules <= SHAPE_INPUT_MAX.modules && o.chaptersPerModule <= SHAPE_INPUT_MAX.chaptersPerModule;
}

/** Reparte en EXACTAMENTE k grupos consecutivos lo más parejos posible (los primeros, uno más; puede haber vacíos). */
function splitEven<T>(xs: T[], k: number): T[][] {
  const out: T[][] = [];
  const base = Math.floor(xs.length / k);
  let extra = xs.length % k;
  let i = 0;
  for (let g = 0; g < k; g++) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    out.push(xs.slice(i, i + size));
    i += size;
  }
  return out;
}

/** Forma que trae el documento (capítulos de contenido por módulo), o null si no trae unidades con contenidos. */
export function documentStructureShape(ctx: AcademicContextV1): number[] | null {
  const p = proposeStructureFromContext(ctx);
  return p.available ? p.modules.map((m) => m.chapters.length) : null;
}

/**
 * Fase 3 · los contenidos del documento en la forma que eligió la institución (p. ej. un documento 4 × 5 en 3 × 4).
 * Cada contenido queda en EXACTAMENTE un capítulo (en el orden del documento: nunca se omite ni se duplica) y cada
 * capítulo dice de qué contenidos viene (sourceContentIds: la trazabilidad que verifica la cobertura). Los resultados
 * vienen de los contenidos y de sus unidades. Si el documento trae menos contenidos que capítulos, los que sobran se
 * marcan como profundización sin contenido del documento (nunca se inventa un contenido).
 */
export function proposeShapedStructureFromContext(ctx: AcademicContextV1, shape: StructureShape): ContextStructureProposal {
  const notes: string[] = [];
  const units = ctx.units.filter((u) => u.contents.length > 0);
  if (!isValidShape(shape) || !units.length) {
    return {
      contextDesignVersion: CONTEXT_DESIGN_VERSION, available: false, notes, modules: [], finalExam: true,
      reason: !units.length ? 'El documento no trae unidades ni contenidos para repartir en otra estructura.' : 'La estructura pedida no es válida.',
      counts: { modules: 0, chapters: 0, linkedChapters: 0, inferredLinks: 0, outcomesCovered: 0, outcomesTotal: ctx.outcomes.length },
    };
  }
  const outcomes = [...ctx.outcomes.map((o) => ({ id: o.id, text: o.text })), ...ctx.competencies.map((c) => ({ id: c.id, text: c.text }))];
  const raOnly = ctx.outcomes.map((o) => ({ id: o.id, text: o.text }));
  const items = units.flatMap((u) => u.contents.map((c) => ({ c, u })));
  const seenTitles = new Set<string>();
  const uniqueTitle = (t: string, suffix: string) => {
    let title = t;
    if (seenTitles.has(title.toLowerCase())) title = `${t.slice(0, STRUCTURE_TITLE_MAX - suffix.length - 3)} (${suffix})`;
    seenTitles.add(title.toLowerCase());
    return title;
  };
  const N = shape.modules;
  const M = shape.chaptersPerModule;
  let extraChapters = 0;
  const modules: ContextModuleProposal[] = splitEven(items, N).map((group, mi) => {
    // Título del módulo: la unidad que más contenidos aporta; las demás que aporta quedan nombradas en la descripción.
    const spanned = [...new Map(group.map((x) => [x.u.id, x.u])).values()];
    const dominant = spanned.map((u) => ({ u, n: group.filter((x) => x.u === u).length })).sort((a, b) => b.n - a.n)[0];
    const t = dominant ? titleAndRest(dominant.u.title) : { title: `Módulo ${mi + 1}`, rest: null };
    const moduleTitle = uniqueTitle(t.title, `M${mi + 1}`);
    const unitLinks = [...new Set(spanned.flatMap((u) => u.outcomeIds))];
    const chapters = splitEven(group, M).map((g, ci): ContextChapterProposal => {
      if (g.length) {
        const links = [...new Set(g.flatMap((x) => x.u.outcomeIds))];
        return chapterFromContents(g.map((x) => x.c), links, outcomes, raOnly, (tt) => uniqueTitle(tt, `${mi + 1}.${ci + 1}`));
      }
      extraChapters++;
      const k = ci - group.length + 1;
      const base = `Profundización ${k}: ${moduleTitle}`;
      return {
        title: uniqueTitle(base.length <= STRUCTURE_TITLE_MAX ? base : `Profundización ${k}`, `${mi + 1}.${ci + 1}`),
        objective: null, description: null, videoEnabled: true, activityEnabled: true, outcomeIds: [...unitLinks].sort(cmpOutcome).slice(0, 8),
        linkStatus: unitLinks.length ? 'found' : 'none', sourceContentIds: [],
      };
    });
    const others = spanned.filter((u) => u !== (dominant && dominant.u)).map((u) => titleAndRest(u.title).title);
    const desc = [t.rest, others.length ? `También incluye contenidos de: ${others.join(' · ')}.` : null].filter(Boolean).join(' ');
    return {
      title: moduleTitle,
      objective: null,
      description: desc ? clip(desc, 2000) : null,
      examEnabled: true,
      outcomeIds: [...new Set([...unitLinks, ...chapters.flatMap((c) => c.outcomeIds)])].sort(cmpOutcome),
      sourceUnitId: dominant ? dominant.u.id : '',
      chapters,
    };
  });
  const docShape = units.map((u) => Math.min(DISTRIBUTOR_RULES.maxContentChaptersPerModule, u.contents.length));
  notes.push(`Los ${items.length} contenidos de las ${units.length} unidades del documento quedan en ${N} × ${M}: cada contenido en un solo capítulo (ninguno se pierde ni se repite).`);
  if (items.length > N * M) notes.push(`Hay más contenidos (${items.length}) que capítulos (${N * M}): algunos capítulos agrupan varios contenidos y los listan.`);
  if (extraChapters) notes.push(`${extraChapters === 1 ? 'Un capítulo no tiene' : `${extraChapters} capítulos no tienen`} contenido del documento (el documento trae ${items.length} contenidos para ${N * M} capítulos): quedan como profundización.`);
  if (N !== units.length || docShape.some((n) => n !== M)) notes.push(`El documento organiza sus contenidos en ${units.length} ${units.length === 1 ? 'unidad' : 'unidades'} (${docShape.join(', ')} contenidos por unidad); la estructura elegida es ${N} × ${M}.`);
  return finishContextProposal(ctx, modules, notes);
}

/**
 * Cierre común de una propuesta a partir del documento: ningún resultado queda sin capítulo si alguno comparte términos
 * con él, los capítulos sin resultado toman el que mejor les encaja, y los conteos. Lo usan la estructura del documento y
 * la redistribución en otra forma (Fase 3).
 */
function finishContextProposal(ctx: AcademicContextV1, modules: ContextModuleProposal[], notes: string[]): ContextStructureProposal {
  const outcomes = [...ctx.outcomes.map((o) => ({ id: o.id, text: o.text })), ...ctx.competencies.map((c) => ({ id: c.id, text: c.text }))];
  const raOnly = ctx.outcomes.map((o) => ({ id: o.id, text: o.text }));
  // LOOP 9.2 · Ningún resultado del documento queda sin capítulo si algún capítulo comparte términos con él: se vincula
  // al que mejor le encaja (inferido: el docente lo ve y lo cambia). Igual con un capítulo sin ningún resultado.
  const allChapters = modules.flatMap((m) => m.chapters);
  const textOf = (c: ContextChapterProposal) => [c.title, c.description || ''].join(' ');
  const score = (a: string, b: string) => tokenContainment(a, b) + tokenJaccard(a, b);
  const covering = () => new Set(allChapters.flatMap((c) => c.outcomeIds));
  for (const o of raOnly) {
    if (covering().has(o.id)) continue;
    const best = allChapters.map((c, i) => ({ c, i, s: score(textOf(c), o.text) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i)[0];
    if (best) { best.c.outcomeIds = [...best.c.outcomeIds, o.id].sort(cmpOutcome).slice(0, 8); best.c.linkStatus = 'inferred'; } // review M5
  }
  for (const c of allChapters) {
    if (c.outcomeIds.length || !raOnly.length) continue;
    const best = raOnly.map((o) => ({ o, s: score(textOf(c), o.text) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0];
    if (best) { c.outcomeIds = [best.o.id]; c.linkStatus = 'inferred'; }
  }
  for (const m of modules) {
    m.outcomeIds = [...new Set([...m.outcomeIds, ...m.chapters.flatMap((c) => c.outcomeIds)])].sort(cmpOutcome);
    const texts = m.outcomeIds.map((id) => outcomes.find((o) => o.id === id)).filter((o): o is { id: string; text: string } => !!o && o.id.startsWith('RA'));
    if (texts.length) m.objective = clip(texts.map((o) => o.text.replace(/\.$/, '')).join('; ') + '.', 1000);
  }
  const linked = modules.flatMap((m) => m.chapters).filter((c) => c.outcomeIds.length);
  const covered = new Set(linked.flatMap((c) => c.outcomeIds));
  const uncovered = ctx.outcomes.filter((o) => !covered.has(o.id));
  if (uncovered.length) notes.push(`${uncovered.map((o) => o.id).join(', ')} no quedaron vinculados a ningún capítulo: vincúlalos a mano o revisa el documento.`);
  return {
    contextDesignVersion: CONTEXT_DESIGN_VERSION,
    available: true,
    reason: null,
    modules,
    finalExam: true,
    notes,
    counts: {
      modules: modules.length,
      chapters: modules.reduce((a, m) => a + m.chapters.length, 0),
      linkedChapters: linked.length,
      inferredLinks: linked.filter((c) => c.linkStatus === 'inferred').length,
      outcomesCovered: ctx.outcomes.filter((o) => covered.has(o.id)).length,
      outcomesTotal: ctx.outcomes.length,
    },
  };
}

function cmpOutcome(a: string, b: string): number {
  const pa = a.startsWith('RA') ? 0 : 1;
  const pb = b.startsWith('RA') ? 0 : 1;
  return pa - pb || Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
}

// ── 3. Vínculos para una estructura existente ─────────────────────────────────────────────────────────────

export interface ExistingChapterInput {
  id: string;
  moduleId: string;
  title: string;
  objective: string | null;
  description?: string | null;
  outcomeIds?: string[] | null;
}

export interface OutcomeLinkSuggestion {
  chapterId: string;
  current: string[];
  suggested: string[];
  status: 'keep' | 'inferred' | 'none';
}

/**
 * Para cada capítulo de una estructura existente: los resultados que mejor le encajan por términos (título +
 * objetivo + descripción contra el resultado y los contenidos de la unidad que lo vincula). Un capítulo que ya
 * tiene vínculos se conserva («keep»): la sugerencia nunca pisa una decisión del docente.
 */
export function suggestOutcomeLinks(ctx: AcademicContextV1, chapters: ExistingChapterInput[]): OutcomeLinkSuggestion[] {
  // Dos niveles: coincidencia DIRECTA con el texto del resultado (manda) y, de respaldo, con el resultado + su unidad
  // (título y contenidos de la unidad que lo vincula).
  const targets = ctx.outcomes.map((o) => ({
    id: o.id,
    own: o.text,
    unit: [o.text, ...ctx.units.filter((u) => u.outcomeIds.includes(o.id) || u.contents.some((c) => c.outcomeIds.includes(o.id))).flatMap((u) => [u.title, ...u.contents.map((c) => c.text)])].join(' '),
  }));
  return chapters.map((ch) => {
    const current = [...(ch.outcomeIds ?? [])];
    if (current.length) return { chapterId: ch.id, current, suggested: current, status: 'keep' as const };
    const text = [ch.title, ch.objective ?? '', ch.description ?? ''].join(' ');
    const scored = targets
      .map((t) => {
        const d = tokenContainment(text, t.own);
        return { id: t.id, direct: d >= LINK_CONTAINMENT_MIN ? d : 0, unit: tokenContainment(text, t.unit), j: tokenJaccard(text, t.own) };
      })
      .filter((x) => x.direct > 0 || x.unit >= LINK_CONTAINMENT_MIN)
      .sort((a, b) => b.direct - a.direct || b.unit - a.unit || b.j - a.j || cmpOutcome(a.id, b.id));
    const best = scored[0];
    // Un segundo resultado entra solo si empata en los dos niveles (no por vecindad de unidad).
    const suggested = best ? scored.filter((x) => x.direct === best.direct && x.unit === best.unit).slice(0, 2).map((x) => x.id).sort(cmpOutcome) : [];
    return { chapterId: ch.id, current, suggested, status: suggested.length ? ('inferred' as const) : ('none' as const) };
  });
}
