import { ACADEMIC_LIMITS } from '../academic-context';
import type { SourceLine } from '../extract/text-sources';
import type { DocumentRequirement, RequirementGroup, RequirementsExtraction } from './requirements';
import { extractRequirements, requirementsFor } from './requirements-extractor';
import type { RequirementItem, RequirementsView } from './document-requirements';

/**
 * r109 M3c · Caja «Requisitos obligatorios» del docente.
 *
 * El docente escribe lo que el curso DEBE tener («4 módulos: Movilidad segura 4 capítulos, Normas de tránsito 7 capítulos…
 * 28 horas»). Ese texto pasa por el MISMO lector determinista de requisitos que un documento (sin IA, USD 0), en modo
 * declarativo: una cifra con su sustantivo es una declaración aunque no traiga un verbo de obligación.
 *
 * Es una fuente propia («Requisitos del docente») y está POR ENCIMA del documento: si choca con un requisito del documento
 * (misma `key`, o la misma estructura), gana la caja; el del documento queda inactivo con un aviso visible. Nunca se
 * descarta en silencio. La pantalla muestra lo entendido y lo que NO se entendió antes de usarla.
 *
 * Vive en courses.metadata.requirementsBox = { version, text, at } (sin migración). Los requisitos se recalculan del texto
 * al leer (el lector es determinista): no hay una copia que se pueda desactualizar.
 */

export const REQUIREMENTS_BOX_KEY = 'requirementsBox';
export const BOX_DOCUMENT_ID = '__box__';
export const BOX_SOURCE_NAME = 'Requisitos del docente';
/** Tope de largo: el de un texto del contexto académico por el número de módulos que admite una lista (ACADEMIC_LIMITS). */
export const BOX_MAX_CHARS = ACADEMIC_LIMITS.text * 4;
const ID_PREFIX = 'BX-';

export interface StoredBox {
  version: 1;
  text: string;
  at: string;
}

export function parseBox(v: unknown): StoredBox | null {
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.text !== 'string' || !o.text.trim()) return null;
  return { version: 1, text: o.text, at: typeof o.at === 'string' ? o.at : '' };
}

/** El texto de la caja → líneas del lector (una por renglón no vacío; `line` = el renglón del texto, desde 1). */
export function boxSourceLines(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  text.replace(/\r/g, '').split('\n').forEach((raw, i) => {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t) out.push({ text: t, page: null, line: i + 1 });
  });
  return out;
}

const pfx = (id: string) => `${ID_PREFIX}${id}`;

/** Lectura de la caja con ids propios («BX-RQ1»), para no chocar con los del documento. */
export function extractBox(text: string): RequirementsExtraction {
  const x = extractRequirements(boxSourceLines(text), BOX_DOCUMENT_ID, { declarative: true });
  return {
    ...x,
    requirements: x.requirements.map((r) => ({ ...r, id: pfx(r.id), ...(r.groupId ? { groupId: pfx(r.groupId) } : {}) })),
    groups: x.groups.map((g): RequirementGroup => ({
      ...g, id: pfx(g.id),
      ...(g.requirementIds ? { requirementIds: g.requirementIds.map(pfx) } : {}),
      ...(g.options ? { options: g.options.map((o) => ({ ...o, requirementIds: o.requirementIds.map(pfx) })) } : {}),
    })),
    conflicts: x.conflicts.map((c) => ({ ...c, requirementIds: c.requirementIds.map(pfx), message: c.message.replace(/^El documento dice/, 'La caja de requisitos dice') })),
  };
}

/** Módulo (1-based) de un requisito de horas con alcance «módulo N»; null si no lo es. */
export function moduleIndexOf(r: DocumentRequirement): number | null {
  const s = r.scope as { level: string; index?: number; each?: boolean };
  return r.kind === 'target_hours' && s.level === 'module' && !s.each && typeof s.index === 'number' ? s.index : null;
}

/**
 * r109 M4 · horas por módulo que declara una lista de requisitos (alineadas con los módulos; null = el texto no las da).
 * Solo las exactas y vigentes; otro valor del mismo módulo no pisa al primero (el conflicto lo muestra el lector).
 */
export function moduleHoursOfRequirements(rs: DocumentRequirement[]): (number | null)[] | null {
  const d = moduleHoursDetail(rs);
  return d ? d.hours : null;
}

/** Igual que `moduleHoursOfRequirements`, con el origen de cada módulo: «de tus requisitos» (la caja) o «del documento». */
export function moduleHoursDetail(rs: DocumentRequirement[]): { hours: (number | null)[]; origins: ('requirements_box' | 'document' | null)[] } | null {
  const hours: (number | null)[] = [];
  const origins: ('requirements_box' | 'document' | null)[] = [];
  for (const r of rs) {
    const i = moduleIndexOf(r);
    if (i === null || r.mode !== 'exact' || typeof r.value !== 'number' || r.active === false || (r as { applies?: boolean }).applies === false) continue;
    while (hours.length < i) { hours.push(null); origins.push(null); }
    if (hours[i - 1] === null) { hours[i - 1] = r.value; origins[i - 1] = r.source && r.source.documentId === BOX_DOCUMENT_ID ? 'requirements_box' : 'document'; }
  }
  return hours.length ? { hours, origins } : null;
}

const n1 = (n: number) => String(n).replace('.', ',');
const plural = (n: number, one: string, many: string) => `${n1(n)} ${n === 1 ? one : many}`;
const KIND_NOUN: Record<string, [string, string]> = {
  modules: ['módulo', 'módulos'], units: ['unidad', 'unidades'], chapters: ['capítulo', 'capítulos'], videos: ['video', 'videos'],
  application_activities: ['Actividad de Aplicación', 'Actividades de Aplicación'], activities: ['actividad interactiva', 'actividades interactivas'],
  evaluations: ['evaluación', 'evaluaciones'],
};

/** Una línea corta de lo entendido («4 módulos · capítulos 4 / 7 / 4 / 5», «28 h»). */
export function boxRequirementText(r: DocumentRequirement): string {
  if (r.kind === 'structure') {
    const sh = r.shape || [];
    return `${plural(sh.length, 'módulo', 'módulos')} · capítulos ${sh.join(' / ')}`;
  }
  const v = r.value as number;
  if (r.kind === 'target_hours' && moduleIndexOf(r) !== null) return `${n1(v)} h en el módulo ${moduleIndexOf(r)}`;
  if (r.kind === 'target_hours') {
    const q = r.mode === 'min' ? 'al menos ' : r.mode === 'max' ? 'hasta ' : r.mode === 'approx' ? 'aprox. ' : r.mode === 'range' ? `${n1(v)}–` : '';
    return `${q}${n1(r.mode === 'range' ? (r.valueMax ?? v) : v)} h`;
  }
  const [one, many] = KIND_NOUN[r.kind] || [r.kind, r.kind];
  const q = r.mode === 'min' ? 'al menos ' : r.mode === 'max' ? 'hasta ' : r.mode === 'approx' ? 'aprox. ' : '';
  const sc = r.scope as { level: string; each?: boolean; chapterKind?: string };
  const where = sc.each && sc.level === 'module' ? ' por módulo' : sc.each && sc.level === 'chapter' ? ' por capítulo' : '';
  const kind = r.kind === 'chapters' && sc.chapterKind ? ` de ${sc.chapterKind === 'practice' ? 'práctica' : 'contenido'}` : '';
  return `${q}${plural(v, one, many)}${kind}${where}`;
}

export interface BoxUnderstood {
  /** «4 módulos · capítulos 4 / 7 / 4 / 5 · 28 h» (vacío si no se entendió nada). */
  summary: string;
  lines: { requirementId: string; kind: string; text: string; line: number; applies: boolean }[];
  /** La forma por módulo, si la caja la dio. */
  shape: number[] | null;
  moduleTitles: (string | null)[] | null;
  hours: number | null;
  /** r109 M4: horas de cada módulo si la caja las dio (null en los módulos sin horas); null si no dio ninguna. */
  moduleHours: (number | null)[] | null;
}

export interface BoxNotUnderstood {
  /** Renglón de la caja (desde 1), o null si no es de un renglón. */
  line: number | null;
  text: string;
  reason: string;
}

export interface BoxOverride {
  boxRequirementId: string;
  documentRequirementId: string;
  message: string;
}

export interface BoxView {
  present: true;
  text: string;
  at: string;
  sourceName: string;
  understood: BoxUnderstood;
  notUnderstood: BoxNotUnderstood[];
  overrides: BoxOverride[];
  conflicts: RequirementsExtraction['conflicts'];
}

const REASONS: Record<string, string> = {
  example: 'Parece un ejemplo, no un requisito.',
  reference: 'Parece una referencia («capítulo 6»), no una cantidad.',
  payment: 'Es un valor de pago; Cursia no lo usa.',
  component_hours: 'Son horas de un componente (clase, acompañamiento…), no el total del curso.',
  no_trigger: 'No dice qué debe tener el curso.',
  condition_clause: 'Está dentro de una condición.',
  not_modeled: 'Cursia no diseña eso.',
  not_prescriptive: 'Se declara como no prescriptivo.',
  inconsistent: 'Dice una cantidad de módulos y lista otra.',
};

/** Familia «estructura»: lo que una forma de la caja reemplaza del documento aunque no tengan la misma `key`. */
const isStructureFamily = (r: DocumentRequirement) => {
  const s = r.scope as { level: string; each?: boolean; chapterKind?: string };
  return r.kind === 'structure' || (r.kind === 'modules' && s.level === 'course') || (r.kind === 'chapters' && (s.level === 'course' || (s.level === 'module' && !!s.each)) && s.chapterKind !== 'practice');
};

/** ¿El valor `v` cumple lo que pide el requisito (exacto, mínimo, máximo, rango, aproximado)? */
function meetsValue(r: DocumentRequirement, v: number): boolean {
  const x = r.value as number;
  switch (r.mode) {
    case 'exact': return v === x;
    case 'min': return v >= x;
    case 'max': return v <= x;
    case 'range': return v >= x && v <= (r.valueMax ?? x);
    case 'approx': return Math.abs(v - x) <= Math.max(1, 0.1 * x);
    default: return true;
  }
}

/**
 * r109 M3c (ronda 1, P1-2) · una caja PARCIAL («3 módulos», «6 capítulos por módulo») también reemplaza la `structure` del
 * documento cuando la contradice: esa forma sale de la misma frase que ya se reemplazó, y dejarla activa dejaba dos
 * requisitos obligatorios que ninguna forma cumple a la vez.
 */
function contradictsBoxCount(doc: DocumentRequirement, boxWins: RequirementItem[]): boolean {
  if (doc.kind !== 'structure' || !doc.shape || !doc.shape.length) return false;
  const mods = boxWins.find((b) => b.kind === 'modules' && b.scope.level === 'course' && typeof b.value === 'number' && b.obligation === 'required');
  if (mods && !meetsValue(mods, doc.shape.length)) return true;
  const chs = boxWins.find((b) => b.kind === 'chapters' && b.scope.level === 'module' && !!(b.scope as { each?: boolean }).each && (b.scope as { chapterKind?: string }).chapterKind !== 'practice' && typeof b.value === 'number' && b.obligation === 'required');
  return !!chs && doc.shape.some((n) => !meetsValue(chs, n));
}

function hoursOf(rs: RequirementItem[]): number | null {
  const h = rs.find((r) => r.kind === 'target_hours' && r.scope.level === 'course' && r.applies && typeof r.value === 'number');
  return h ? (h.value as number) : null;
}

/** La vista de requisitos con la caja encima: sin caja (null) devuelve la MISMA vista, byte a byte. */
export function applyBoxToView(view: RequirementsView, box: StoredBox | null): RequirementsView {
  if (!box) return view;
  const x = extractBox(box.text);
  const applying = new Set(requirementsFor({ ...x, ignored: [] }, {}).map((r) => r.id));
  const boxItems: RequirementItem[] = x.requirements.map((r) => ({ ...r, documentName: BOX_SOURCE_NAME, applies: applying.has(r.id), fromBox: true as const }));
  const boxWins = boxItems.filter((i) => i.applies && i.obligation !== 'informative');
  const boxKeys = new Map<string, RequirementItem>();
  for (const b of boxWins) if (!boxKeys.has(b.key)) boxKeys.set(b.key, b);
  const boxStructure = boxWins.find((b) => b.kind === 'structure');
  // r109 M4: si la caja trae horas por módulo (aunque sea de algunos), TODAS las horas por módulo del documento quedan
  // reemplazadas: los módulos que la caja no menciona quedan sin horas propias.
  const boxModuleHours = boxWins.find((b) => moduleIndexOf(b) !== null && b.mode === 'exact');

  const overrides: BoxOverride[] = [];
  const replaced = new Set<string>();
  const docItems: RequirementItem[] = view.items.map((it) => {
    if (!it.applies) return it;
    const by = boxKeys.get(it.key) || (boxStructure && isStructureFamily(it) ? boxStructure : undefined) || (boxModuleHours && moduleIndexOf(it) !== null ? boxModuleHours : undefined)
      || (contradictsBoxCount(it, boxWins) ? boxWins.find((b) => b.kind === 'modules' || b.kind === 'chapters') : undefined);
    if (!by) return it;
    // P2-3: una recomendación de la caja («aproximadamente 28 horas») no vuelve «recomendación» un mínimo obligatorio del documento.
    if (by.obligation !== 'required' && it.obligation === 'required') return it;
    const message = `La caja de requisitos reemplaza a «${it.source.quote.slice(0, 80)}» del documento.`;
    overrides.push({ boxRequirementId: by.id, documentRequirementId: it.id, message });
    replaced.add(it.id);
    return { ...it, active: false, applies: false, overriddenByBox: true as const, review: [...(it.review || []), message] };
  });

  const items = [...docItems, ...boxItems];
  const understoodItems = boxItems.filter((i) => i.obligation !== 'informative');
  const st = boxWins.find((b) => b.kind === 'structure');
  const hours = hoursOf(boxWins);
  const moduleHours = moduleHoursOfRequirements(boxWins);
  const mods = boxWins.find((b) => b.kind === 'modules' && b.scope.level === 'course');
  const parts: string[] = [];
  if (st) parts.push(boxRequirementText(st));
  else if (mods) parts.push(boxRequirementText(mods));
  for (const b of boxWins) {
    if (b === st || b === mods) continue;
    if (st && b.kind === 'chapters' && b.scope.level === 'module' && st.shape && st.shape.every((n) => n === (b.value as number))) continue;
    if (b.kind === 'target_hours' && b.value === hours) continue;
    if (moduleIndexOf(b) !== null) continue;
    parts.push(boxRequirementText(b));
  }
  if (moduleHours) parts.push(`horas por módulo ${moduleHours.map((h) => (h === null ? '—' : n1(h))).join(' / ')} h`);
  if (hours !== null) parts.push(`${n1(hours)} h`);

  // Lo que NO se convirtió en requisito: renglones sin requisito y cifras que el lector apartó.
  const lines = boxSourceLines(box.text);
  const withReq = new Set(boxItems.map((i) => i.source.line));
  const notUnderstood: BoxNotUnderstood[] = [];
  for (const l of lines) {
    if (!withReq.has(l.line) && !x.ignored.some((g) => g.line === l.line && g.reason === 'inconsistent')) {
      notUnderstood.push({ line: l.line, text: l.text.slice(0, 200), reason: 'No dice qué debe tener el curso (módulos, capítulos, horas, videos…).' });
    }
  }
  for (const g of x.ignored) {
    if (g.reason === 'component_hours' && /horas por módulo/.test(g.quote)) { notUnderstood.push({ line: g.line, text: 'horas por módulo', reason: 'No pude leer estas horas como las de un módulo (¿son de clase, de un componente o un rango?). Escríbelas así: «Módulo 2: 12 horas».' }); continue; }
    notUnderstood.push({ line: g.line, text: g.quote, reason: REASONS[g.reason] || 'No se usó como requisito.' });
  }
  notUnderstood.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  const boxView: BoxView = {
    present: true, text: box.text, at: box.at, sourceName: BOX_SOURCE_NAME,
    understood: {
      summary: parts.join(' · '),
      lines: understoodItems.map((i) => ({ requirementId: i.id, kind: i.kind, text: boxRequirementText(i), line: i.source.line, applies: i.applies })),
      shape: st && st.shape ? [...st.shape] : null,
      moduleTitles: st && st.moduleTitles && st.moduleTitles.some((t) => t) ? [...st.moduleTitles] : null,
      hours,
      moduleHours,
    },
    notUnderstood, overrides, conflicts: x.conflicts,
  };

  const conflicts = [
    ...view.conflicts.filter((c) => !c.requirementIds.every((id) => replaced.has(id))),
    ...x.conflicts,
  ];
  return {
    ...view,
    // Con requisitos de la caja, la vista vale aunque no haya lectura del documento («Requisitos del docente» es una fuente).
    // P2-2: una lectura desactualizada del documento (stale) se sigue diciendo; solo «none» (sin documento) pasa a «current».
    state: view.state === 'none' && boxItems.length ? 'current' : view.state,
    items,
    groups: [...view.groups, ...x.groups],
    conflicts,
    box: boxView,
  };
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };

/** Guarda la caja del curso; texto vacío = sin caja (se borra la clave: todo igual que antes de usarla). */
export async function writeRequirementsBox(q: Q, courseId: number, text: string, at = new Date().toISOString()): Promise<void> {
  const t = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (!t) {
    await q.query(`update public.courses set metadata = coalesce(metadata, '{}'::jsonb) - '${REQUIREMENTS_BOX_KEY}' where id = $1`, [courseId]);
    return;
  }
  const box: StoredBox = { version: 1, text: t, at };
  await q.query(
    `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{${REQUIREMENTS_BOX_KEY}}', $2::jsonb, true) where id = $1`,
    [courseId, JSON.stringify(box)],
  );
}

/**
 * Los títulos de módulo que escribió el docente para ESTA forma (los mismos capítulos por módulo): solo si la caja dio al
 * menos uno; null en los módulos sin título (se queda el de siempre). null si la forma elegida no es la de la caja.
 */
export function boxModuleTitlesFor(required: DocumentRequirement[], counts: number[]): (string | null)[] | null {
  const st = required.find((r) => r.kind === 'structure' && r.source && r.source.documentId === BOX_DOCUMENT_ID && Array.isArray(r.shape)
    && r.shape.length === counts.length && r.shape.every((n, i) => n === counts[i]) && Array.isArray(r.moduleTitles) && r.moduleTitles.some((t) => t));
  return st ? [...st.moduleTitles!] : null;
}
