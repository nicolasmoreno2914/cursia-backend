import { buildRequirementsView, currentEntry, loadRequirementsState, RequirementCheck, RequirementsView } from './document-requirements';
import type { DocumentRequirement } from './requirements';
import { liveStructureShape, readStructureOrigin } from '../../course-structure/structure-authority';
import { readCourseFormat } from '../../prebrief/course-formats';

/**
 * LOOP 8.6C · Autoridad de los requisitos del documento sobre «Cursia recomienda».
 *
 * Jerarquía: 1) requisito OBLIGATORIO del documento · 2) decisión explícita del docente · 3) Cursia recomienda ·
 * 4) valores por defecto. Cursia diseña DENTRO de los límites del documento:
 *   - las restricciones que puede cumplir sin tocar decisiones del docente las pasa al distribuidor (no agregar
 *     capítulos por encima del máximo, completar el mínimo con capítulos propuestos, video en cada capítulo, topes de
 *     Actividades de Aplicación) y las horas del documento pasan a ser la meta cuando el docente no eligió otras;
 *   - lo que NO puede cumplir (módulos de más o de menos, capítulos que ya existen por encima del máximo, dos videos por
 *     capítulo, horas que chocan con la estructura exigida…) NO lo resuelve solo: va a Verificación como conflicto
 *     crítico, diciendo qué requisito choca con cuál;
 *   - lo que el docente decidió en contra del documento no se borra ni se revierte: queda como «Excepción al requisito
 *     del documento» (advertencia en Verificación).
 * Las alternativas (S/M/L) solo restringen cuando el docente eligió una. Los críticos bloquean la generación en el
 * servidor (R68, GenerationDesignGate).
 *
 * Las restricciones dependen SOLO de lo guardado (requisitos, alternativa elegida, excepciones registradas): «Usar este
 * diseño» recalcula la misma propuesta y la misma huella.
 */

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };

export const REQUIREMENT_EXCEPTIONS_KEY = 'requirementExceptions';
/** Decisiones del docente que pueden apartarse del documento y se registran (las horas y la estructura ya tienen origen). */
export const EXCEPTION_FIELDS = ['audiovisual', 'applicationActivities'] as const;
export type ExceptionField = (typeof EXCEPTION_FIELDS)[number];
export const EXCEPTION_VALUES: Record<ExceptionField, readonly string[]> = {
  audiovisual: ['less', 'recommended', 'more'],
  applicationActivities: ['auto', 'practice_only', 'none'],
};

export interface StoredExceptions {
  /** Huella de los documentos (como la elección de alternativa): con otros documentos, no valen. */
  key: string;
  fields: Partial<Record<ExceptionField, { value: string; at: string }>>;
  /**
   * Review L86C I1: prioridad audiovisual que eligió CURSIA para cumplir el documento (guardada en el perfil al usar el
   * diseño). Sirve para distinguirla de una elegida por el docente en «Avanzado».
   */
  cursia?: { audiovisual?: string };
}

/** Valores por defecto de los campos que el docente puede decidir (los que pone Cursia si nadie eligió). */
export const DECISION_DEFAULTS: Record<ExceptionField, string> = { audiovisual: 'recommended', applicationActivities: 'auto' };

/**
 * Review L86C I1 · decisiones IMPLÍCITAS del docente: lo guardado en el perfil (p. ej. desde «Avanzado») que no es el
 * valor por defecto ni lo que eligió Cursia. Cursia nunca escribe `applicationActivities`; la prioridad audiovisual solo
 * la cambia para cumplir el documento, y entonces queda registrada en `cursia`.
 */
export function implicitDecisions(savedPrefs: Record<string, unknown> | null | undefined, cursia?: StoredExceptions['cursia']): StoredExceptions['fields'] {
  const out: StoredExceptions['fields'] = {};
  const p = savedPrefs || {};
  for (const f of EXCEPTION_FIELDS) {
    const v = p[f];
    if (typeof v !== 'string' || !EXCEPTION_VALUES[f].includes(v) || v === DECISION_DEFAULTS[f]) continue;
    if (f === 'audiovisual' && cursia && cursia.audiovisual === v) continue;
    out[f] = { value: v, at: '' };
  }
  return out;
}

/** Restricciones que el distribuidor puede cumplir (todas opcionales). */
export interface DistributorRequirementConstraints {
  /** Capítulos por módulo (D1: los de práctica cuentan). */
  chaptersPerModule?: { min?: number; max?: number };
  /** LOOP 9.2: «N capítulos de contenido por módulo» (las prácticas aparte). */
  contentChaptersPerModule?: { min?: number; max?: number };
  /** LOOP 9.2: «N capítulos de práctica por módulo». */
  practicePerModule?: { min?: number; max?: number };
  /** LOOP 9.2 (review I11): «N capítulos de práctica» en todo el curso. */
  practiceTotal?: { min?: number; max?: number };
  /** LOOP 9.2: las Actividades de Aplicación van en el capítulo de práctica («1 por módulo, en la práctica»). */
  applicationInPractice?: boolean;
  /** LOOP 9.2: total de actividades interactivas del curso («exactamente 4 actividades interactivas H5P»). */
  activitiesTotal?: { min?: number; max?: number };
  /** LOOP 9.2 (review 3.ª I2): «1 actividad interactiva por cada capítulo de contenido»: nunca se apagan las de contenido. */
  activitiesInEveryContent?: boolean;
  /**
   * «1 video por capítulo»: video en todos los capítulos de contenido (los fijados por el docente mandan). Con «2 o más
   * por capítulo» también (es lo más cercano que Cursia puede: un video por capítulo) y Verificación explica el resto.
   */
  videosAllContent?: boolean;
  /** «Sin videos». */
  videosNone?: boolean;
  /** Actividades de Aplicación por módulo y en el curso. */
  applicationPerModule?: { min?: number; max?: number };
  applicationTotal?: { min?: number; max?: number };
  /** Requisito de origen de cada restricción (para explicar los cambios). */
  sources: Partial<Record<'chapters' | 'practice' | 'activities' | 'videos' | 'applicationPerModule' | 'applicationTotal', string>>;
}

function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res && res.rows) || [];
}

export function parseExceptions(v: unknown): StoredExceptions | null {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, any>;
  if (typeof o.key !== 'string' || !o.fields || typeof o.fields !== 'object') return null;
  const fields: StoredExceptions['fields'] = {};
  for (const f of EXCEPTION_FIELDS) {
    const x = o.fields[f];
    if (x && typeof x.value === 'string' && EXCEPTION_VALUES[f].includes(x.value)) fields[f] = { value: x.value, at: typeof x.at === 'string' ? x.at : '' };
  }
  const av = o.cursia && typeof o.cursia.audiovisual === 'string' && EXCEPTION_VALUES.audiovisual.includes(o.cursia.audiovisual) ? o.cursia.audiovisual : null;
  return { key: o.key, fields, ...(av ? { cursia: { audiovisual: av } } : {}) };
}

export async function loadExceptions(q: Q, courseId: number): Promise<StoredExceptions | null> {
  const rows = rowsOf(await q.query(`select metadata -> '${REQUIREMENT_EXCEPTIONS_KEY}' as e from public.courses where id = $1`, [courseId]));
  return rows.length ? parseExceptions(rows[0].e) : null;
}

export async function writeExceptions(q: Q, courseId: number, ex: StoredExceptions): Promise<void> {
  await q.query(
    `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{${REQUIREMENT_EXCEPTIONS_KEY}}', $2::jsonb, true) where id = $1`,
    [courseId, JSON.stringify(ex)],
  );
}

export interface RequirementAuthority {
  view: RequirementsView;
  /** Requisitos que aplican (alternativa elegida, sin condición pendiente). */
  applicable: DocumentRequirement[];
  /**
   * Solo los obligatorios y leídos con confianza ALTA: los que restringen el diseño. Una lectura «Revisa esta lectura»
   * (confianza media: unidades, totales calculados, anáforas…) se muestra pero no tiene autoridad.
   */
  required: DocumentRequirement[];
  /** Excepciones vigentes (de estos documentos). */
  exceptions: StoredExceptions['fields'];
  /** Lo que eligió Cursia para cumplir el documento (de estos documentos). */
  cursia: StoredExceptions['cursia'];
  key: string | null;
}

/** Lo guardado del curso → requisitos que aplican y excepciones (lo mismo para «Cursia recomienda» y «Usar este diseño»). */
export async function loadRequirementAuthority(q: Q, courseId: number, contextDocs: { sha256: string }[]): Promise<RequirementAuthority> {
  const st = await loadRequirementsState(q, courseId);
  const view = buildRequirementsView(st.entries, st.selection, contextDocs);
  const entry = currentEntry(st.entries, contextDocs);
  const applicable = view.items.filter((i) => i.applies);
  // Re-review L86C m-1: siempre se lee (lo que eligió Cursia vale aunque no haya lectura de los documentos actuales).
  const ex = await loadExceptions(q, courseId);
  return {
    view,
    applicable,
    required: applicable.filter((r) => r.obligation === 'required' && r.confidence === 'high'),
    exceptions: ex && entry && ex.key === entry.key ? ex.fields : {},
    // Re-review L86C IMP-1: lo que escribió Cursia en el perfil no depende de los documentos (si cambian, sigue siendo de Cursia).
    cursia: ex ? ex.cursia : undefined,
    key: entry ? entry.key : null,
  };
}

const bounds = (r: DocumentRequirement): { min?: number; max?: number } | null => {
  if (r.value === null || r.value === undefined) return null;
  switch (r.mode) {
    case 'exact': return { min: r.value, max: r.value };
    case 'min': return { min: r.value };
    case 'max': return { max: r.value };
    case 'range': return { min: r.value, max: r.valueMax ?? r.value };
    default: return null; // aproximado: una preferencia, no un límite
  }
};
const merge = (a: { min?: number; max?: number } | undefined, b: { min?: number; max?: number }) => ({
  ...(a?.min !== undefined || b.min !== undefined ? { min: Math.max(a?.min ?? -Infinity, b.min ?? -Infinity) } : {}),
  ...(a?.max !== undefined || b.max !== undefined ? { max: Math.min(a?.max ?? Infinity, b.max ?? Infinity) } : {}),
});

/**
 * Requisitos OBLIGATORIOS → restricciones del distribuidor. Una excepción del docente (prioridad audiovisual o modo de
 * Actividades de Aplicación) quita la restricción de ese campo: manda su decisión y queda registrada como excepción.
 */
/**
 * Piloto (2026-10-07): `structureByTeacher` = el docente armó o cambió la estructura después de que Cursia la armó. Su
 * estructura manda: Cursia ya no vuelve a proponer capítulos para llegar al mínimo del documento (eso queda como
 * «Excepción al requisito del documento»), pero sigue sin pasar del máximo.
 */
export function constraintsFor(required: DocumentRequirement[], exceptions: StoredExceptions['fields'], opts: { structureByTeacher?: boolean } = {}): DistributorRequirementConstraints | null {
  const c: DistributorRequirementConstraints = { sources: {} };
  for (const r of required) {
    const s = r.scope;
    const b = bounds(r);
    const ck = (s as { chapterKind?: 'practice' | 'content' }).chapterKind;
    if (r.kind === 'chapters' && s.level === 'module' && 'each' in s && !ck && b) {
      c.chaptersPerModule = merge(c.chaptersPerModule, b);
      c.sources.chapters = c.sources.chapters || r.id;
    } else if (r.kind === 'chapters' && s.level === 'module' && 'each' in s && ck === 'content' && b) {
      c.contentChaptersPerModule = merge(c.contentChaptersPerModule, b);
      c.sources.chapters = c.sources.chapters || r.id;
    } else if (r.kind === 'chapters' && s.level === 'module' && 'each' in s && ck === 'practice' && b) {
      c.practicePerModule = merge(c.practicePerModule, b);
      c.sources.practice = c.sources.practice || r.id;
    } else if (r.kind === 'chapters' && s.level === 'course' && ck === 'practice' && b) {
      c.practiceTotal = merge(c.practiceTotal, b);
      c.sources.practice = c.sources.practice || r.id;
    } else if (r.kind === 'activities' && s.level === 'course' && b) {
      c.activitiesTotal = merge(c.activitiesTotal, b);
      c.sources.activities = c.sources.activities || r.id;
    } else if (r.kind === 'activities' && s.level === 'chapter' && 'each' in s && ck !== 'practice' && b && (b.min ?? 0) >= 1) {
      c.activitiesInEveryContent = true;
    } else if (r.kind === 'structure' && r.shape && r.shape.length && r.shape.every((n) => n === r.shape![0])) {
      if (ck === 'content') c.contentChaptersPerModule = merge(c.contentChaptersPerModule, { min: r.shape[0], max: r.shape[0] });
      else c.chaptersPerModule = merge(c.chaptersPerModule, { min: r.shape[0], max: r.shape[0] });
      c.sources.chapters = c.sources.chapters || r.id;
    } else if (r.kind === 'videos' && s.level === 'chapter' && 'each' in s && !('chapterKind' in s && s.chapterKind === 'practice') && !exceptions.audiovisual && b) {
      // Review L86C M2: de los límites — ninguno si el máximo es 0; uno en cada capítulo si el mínimo es 1 o más (con «2 o
      // más» es lo más cercano que Cursia puede, y Verificación explica el resto).
      if (b.max === 0) c.videosNone = true;
      else if ((b.min ?? 0) >= 1) c.videosAllContent = true;
      if (c.videosNone || c.videosAllContent) c.sources.videos = c.sources.videos || r.id;
    } else if (r.kind === 'videos' && s.level === 'course' && b && b.max === 0 && !exceptions.audiovisual) {
      c.videosNone = true;
      c.sources.videos = c.sources.videos || r.id;
    } else if (r.kind === 'application_activities' && !exceptions.applicationActivities && b) {
      if (s.level === 'module' && 'each' in s) {
        c.applicationPerModule = merge(c.applicationPerModule, b);
        c.sources.applicationPerModule = c.sources.applicationPerModule || r.id;
        if (ck === 'practice') c.applicationInPractice = true;
      } else if (s.level === 'course') {
        c.applicationTotal = merge(c.applicationTotal, b);
        c.sources.applicationTotal = c.sources.applicationTotal || r.id;
      }
    }
  }
  if (c.videosAllContent && c.videosNone) { delete c.videosAllContent; delete c.videosNone; } // contradictorio: lo explica Verificación
  // Review L86C I4: requisitos del documento que se contradicen (mínimo por encima del máximo): Cursia no elige entre ellos
  // ni pasa del máximo; no restringe ese campo y Verificación muestra el choque en los dos.
  const crossed = (x?: { min?: number; max?: number }) => !!x && x.min !== undefined && x.max !== undefined && x.min > x.max;
  if (crossed(c.chaptersPerModule)) { delete c.chaptersPerModule; delete c.sources.chapters; }
  if (crossed(c.contentChaptersPerModule)) { delete c.contentChaptersPerModule; if (c.sources.chapters && !c.chaptersPerModule) delete c.sources.chapters; }
  if (crossed(c.practicePerModule)) { delete c.practicePerModule; delete c.sources.practice; }
  if (crossed(c.practiceTotal)) { delete c.practiceTotal; }
  if (crossed(c.activitiesTotal)) { delete c.activitiesTotal; delete c.sources.activities; }
  // LOOP 9.2 · Review C2: con la estructura del docente, su decisión manda: Cursia no vuelve a proponer capítulos de
  // contenido ni prácticas para llegar al mínimo (solo respeta el máximo) ni cambia sus actividades; la diferencia con el
  // documento queda como «Excepción al requisito del documento».
  const maxOnly = (x?: { min?: number; max?: number }) => (x && x.max !== undefined ? { max: x.max } : undefined);
  // Review 2.ª (I1): la estructura del docente (o un formato elegido) no relaja la práctica ni las actividades: esas
  // desviaciones se registran capítulo a capítulo (actividad fijada) o módulo a módulo (práctica quitada) en designPins.
  if (opts.structureByTeacher) {
    c.contentChaptersPerModule = maxOnly(c.contentChaptersPerModule);
    if (!c.contentChaptersPerModule) delete c.contentChaptersPerModule;
  }
  if (opts.structureByTeacher && c.chaptersPerModule) {
    if (c.chaptersPerModule.max === undefined) { delete c.chaptersPerModule; delete c.sources.chapters; }
    else c.chaptersPerModule = { max: c.chaptersPerModule.max };
  }
  if (crossed(c.applicationPerModule)) { delete c.applicationPerModule; delete c.sources.applicationPerModule; }
  if (crossed(c.applicationTotal)) { delete c.applicationTotal; delete c.sources.applicationTotal; }
  const any = c.chaptersPerModule || c.contentChaptersPerModule || c.practicePerModule || c.practiceTotal || c.activitiesTotal || c.activitiesInEveryContent || c.videosAllContent || c.videosNone || c.applicationPerModule || c.applicationTotal;
  return any ? c : null;
}

/** Lo guardado del curso → restricciones del distribuidor (mismo cálculo en «Cursia recomienda» y en «Usar este diseño»). */
export async function requirementConstraintsForCourse(
  q: Q, courseId: number, contextDocs: { sha256: string }[], savedPrefs: Record<string, unknown> | null | undefined, decisions?: DecisionOverrides,
): Promise<DistributorRequirementConstraints | null> {
  const a = await loadRequirementAuthority(q, courseId, contextDocs);
  return constraintsFor(a.required, teacherDecisions(a, savedPrefs, decisions), { structureByTeacher: await structureEditedByTeacher(q, courseId) });
}

/**
 * El docente armó la estructura (sin origen de Cursia) o cambió su FORMA después (agregó o quitó módulos o capítulos;
 * review piloto I5: corregir un título o fijar un video no cuenta). Orígenes anteriores sin forma: por el contador.
 */
export async function structureEditedByTeacher(q: Q, courseId: number): Promise<boolean> {
  // Prebrief · un formato S/M/L elegido es una decisión de la institución sobre la estructura: manda sobre el documento
  // (si lo contradice, queda como «Excepción al requisito del documento») y Cursia no rellena hasta el mínimo del documento.
  const fmt = await readCourseFormat(q, courseId);
  if (fmt) return true;
  const origin = await readStructureOrigin(q as any, courseId);
  if (!origin) return true;
  if (origin.shape) {
    const live = await liveStructureShape(q as any, courseId);
    return live.length !== origin.shape.length || live.some((n, i) => n !== origin.shape![i]);
  }
  const res = await q.query(`select structure_version_counter c from public.courses where id = $1`, [courseId]);
  const rows: any[] = Array.isArray(res) ? res : (res as any).rows;
  return !rows[0] || Number(rows[0].c) !== origin.counter;
}

/** Decisiones del docente: implícitas (perfil guardado) + registradas + las de la vista previa, menos las que se devuelven. */
export function teacherDecisions(a: Pick<RequirementAuthority, 'exceptions' | 'cursia'>, savedPrefs: Record<string, unknown> | null | undefined, o?: DecisionOverrides): StoredExceptions['fields'] {
  return effectiveDecisions({ ...implicitDecisions(savedPrefs, a.cursia), ...a.exceptions }, o);
}

/** Decisiones de la vista previa: lo que el docente cambia en «Ajustar» (set) o devuelve al documento (clear). */
export interface DecisionOverrides {
  set?: Partial<Record<ExceptionField, string>>;
  clear?: ExceptionField[];
}
export function effectiveDecisions(stored: StoredExceptions['fields'], o?: DecisionOverrides): StoredExceptions['fields'] {
  const out: StoredExceptions['fields'] = { ...stored };
  for (const f of o?.clear || []) delete out[f];
  for (const f of EXCEPTION_FIELDS) {
    const v = o?.set?.[f];
    if (v !== undefined && EXCEPTION_VALUES[f].includes(v)) out[f] = { value: v, at: '' };
  }
  return out;
}

/** Media hora más cercana dentro de [lo, hi] (las metas válidas van de 1 a 500 en pasos de 0,5). */
function halfStep(n: number, lo = 1, hi = 500): number {
  const a = Math.max(1, lo);
  const b = Math.min(500, hi);
  let x = Math.round(Math.min(b, Math.max(a, n)) * 2) / 2;
  // Review L86C M7: el redondeo a media hora nunca saca el valor del intervalo (si cabe una media hora dentro).
  if (x < a) x = Math.ceil(a * 2) / 2;
  if (x > b) x = Math.floor(b * 2) / 2;
  return x;
}

/**
 * Horas que pide el documento (si aplica): obligatorio exacto → ese valor; rango / mínimo / máximo → la propuesta de
 * Cursia llevada dentro del intervalo; aproximado o recomendado → ese valor como sugerencia (sin `required`).
 * null = el documento no dice horas del curso.
 */
export function hoursFromRequirements(applicable: DocumentRequirement[], proposal: number | null): { value: number; requirement: DocumentRequirement; required: boolean } | null {
  const hs = applicable.filter((r) => r.kind === 'target_hours' && r.scope.level === 'course' && typeof r.value === 'number');
  const reqs = hs.filter((r) => r.obligation === 'required' && r.mode !== 'approx' && r.confidence === 'high');
  // Review L86C I4: dos horas obligatorias que no pueden cumplirse a la vez → Cursia no elige ninguna (Verificación lo dice).
  if (reqs.some((a) => reqs.some((b) => a !== b && !compatible(a, b)))) return null;
  if (reqs.length) {
    // Re-review L86C IMP-2: TODAS las horas obligatorias a la vez (la intersección de sus límites); la propuesta de Cursia
    // se lleva dentro. El requisito que se informa es el más restrictivo.
    let lo = 1;
    let hi = 500;
    for (const r of reqs) { const b = bounds(r); if (b) { if (b.min !== undefined) lo = Math.max(lo, b.min); if (b.max !== undefined) hi = Math.min(hi, b.max); } }
    if (lo > hi) return null;
    // Re-review L86C m-4: si en el intervalo no cabe ninguna media hora (p. ej. 40,2–40,3), no hay meta válida que cumpla.
    if (Math.ceil(lo * 2) / 2 > Math.floor(hi * 2) / 2) return null;
    const width = (r: DocumentRequirement) => { const b = bounds(r) || {}; return (b.max ?? 500) - (b.min ?? 1); };
    const req = [...reqs].sort((a, b) => width(a) - width(b))[0];
    const p = proposal ?? lo;
    return { value: halfStep(Math.min(Math.max(p, lo), hi), lo, hi), requirement: req, required: true };
  }
  // Recomendado, aproximado o leído con confianza media: una sugerencia (solo si nadie eligió las horas).
  const soft = hs.find((r) => r.obligation === 'recommended' || r.mode === 'approx' || (r.obligation === 'required' && r.confidence !== 'high'));
  return soft ? { value: halfStep(soft.value as number), requirement: soft, required: false } : null;
}

// ── Verificación ──

/** ¿Dos requisitos de lo mismo pueden cumplirse a la vez? (intervalos que se cruzan). */
function compatible(a: DocumentRequirement, b: DocumentRequirement): boolean {
  const ia = bounds(a);
  const ib = bounds(b);
  if (!ia || !ib) return true;
  const lo = Math.max(ia.min ?? -Infinity, ib.min ?? -Infinity);
  const hi = Math.min(ia.max ?? Infinity, ib.max ?? Infinity);
  return lo <= hi;
}

export interface RequirementDesignCheck {
  id: string;
  area: 'requirements';
  severity: 'ok' | 'info' | 'warning' | 'critical';
  title: string;
  detail?: string;
  fix?: { kind: 'adjust' | 'editor'; action: string; label: string; value?: unknown; targets?: { chapterIds?: string[]; moduleIds?: string[] } };
  /** LOOP 9: requisito que Cursia no puede producir (excepción que exige el motivo de la institución). */
  /**
   * coveredBy (LOOP 9.2): la MISMA limitación ya es una excepción de otro requisito de la misma frase del documento
   * («8 videos de contenido: 2 videos por cada capítulo de contenido»): su motivo cubre los dos (un solo motivo).
   */
  capability?: { requirementKey: string; requirementText: string; produces: string; coveredBy?: { requirementKey: string; requirementText: string } };
}

const n1 = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');
function nounOf(kind: string, n: number, et?: string): string {
  const one = n === 1;
  switch (kind) {
    case 'modules': return one ? 'módulo' : 'módulos';
    case 'chapters': return one ? 'capítulo' : 'capítulos';
    case 'target_hours': return one ? 'hora' : 'horas';
    case 'videos': return one ? 'video' : 'videos';
    case 'application_activities': return one ? 'Actividad de Aplicación' : 'Actividades de Aplicación';
    case 'activities': return one ? 'actividad interactiva' : 'actividades interactivas';
    case 'evaluations': return et === 'partial' ? (one ? 'evaluación parcial' : 'evaluaciones parciales') : et === 'final' ? (one ? 'evaluación final' : 'evaluaciones finales') : (one ? 'evaluación' : 'evaluaciones');
    case 'units': return one ? 'unidad' : 'unidades';
    default: return '';
  }
}
function scopeText(r: DocumentRequirement): string {
  const s = r.scope;
  const ck = (s as { chapterKind?: 'practice' | 'content' }).chapterKind;
  // LOOP 9.2: «1 Actividad de Aplicación por módulo, en el capítulo de práctica» (dónde va, no solo cuántas).
  if (s.level === 'module') return 'each' in s ? (ck === 'practice' && r.kind !== 'chapters' ? ' por módulo, en el capítulo de práctica' : ' por módulo') : ` en el módulo ${s.index}`;
  if (s.level === 'chapter') return ck === 'practice' ? ' por capítulo de práctica' : ck === 'content' ? ' por capítulo de contenido' : ' por capítulo';
  if (s.level === 'outcome') return ' por resultado de aprendizaje';
  if (s.level === 'unit') return 'each' in s ? ' por unidad' : ` en la unidad ${s.index}`;
  return '';
}
/** «3 módulos», «40–44 horas», «2 videos por capítulo», «4 × 5 (20 capítulos)». */
export function requirementText(r: DocumentRequirement): string {
  if (r.kind === 'structure') {
    const sh = r.shape || [];
    const same = sh.length && sh.every((n) => n === sh[0]);
    const content = (r.scope as { chapterKind?: string }).chapterKind === 'content';
    return `estructura ${same ? `${sh.length} × ${sh[0]}` : sh.join(', ')} (${sh.reduce((a, b) => a + b, 0)} ${content ? 'capítulos de contenido' : 'capítulos'})`;
  }
  const v = r.value as number;
  let noun = nounOf(r.kind, r.mode === 'range' ? (r.valueMax ?? v) : v, r.evaluationType);
  // LOOP 9.2: «2 capítulos de contenido por módulo», «1 capítulo de práctica por módulo».
  const ck = (r.scope as { chapterKind?: 'practice' | 'content' }).chapterKind;
  if (r.kind === 'chapters' && ck && r.scope.level !== 'chapter') noun += ck === 'practice' ? ' de práctica' : ' de contenido';
  const q = r.mode === 'range' ? `${n1(v)}–${n1(r.valueMax ?? v)} ${noun}` : r.mode === 'min' ? `al menos ${n1(v)} ${noun}` : r.mode === 'max' ? `hasta ${n1(v)} ${noun}` : r.mode === 'approx' ? `aproximadamente ${n1(v)} ${noun}` : `${n1(v)} ${noun}`;
  return q + scopeText(r);
}
/**
 * LOOP 9.1 (A2): el N×M que lee un cliente cuenta solo los capítulos de contenido; la práctica se nombra aparte.
 * «3 módulos × 4 capítulos de contenido, más 1 capítulo de práctica por módulo».
 */
export function structureActualText(shape: number[], practice?: number[]): string {
  const pr = shape.map((_, i) => (practice && typeof practice[i] === 'number' ? practice[i] : 0));
  const content = shape.map((n, i) => n - pr[i]);
  const mods = `${shape.length} ${shape.length === 1 ? 'módulo' : 'módulos'}`;
  const sameC = content.length && content.every((n) => n === content[0]);
  const head = !shape.length ? '0 módulos'
    : sameC ? `${mods} × ${content[0]} ${content[0] === 1 ? 'capítulo' : 'capítulos'} de contenido`
      : `${mods} con ${content.join(', ')} capítulos de contenido`;
  const totalP = pr.reduce((x, y) => x + y, 0);
  if (!totalP) return head;
  const sameP = pr.every((n) => n === pr[0]);
  return sameP ? `${head}, más ${pr[0]} ${pr[0] === 1 ? 'capítulo' : 'capítulos'} de práctica por módulo` : `${head}, más ${totalP} ${totalP === 1 ? 'capítulo' : 'capítulos'} de práctica`;
}
export function actualText(r: DocumentRequirement, c: RequirementCheck): string {
  const a = c.actual || {};
  if (r.kind === 'structure') {
    return structureActualText(a.shape || [], a.practice);
  }
  // Review M3: «3 capítulos de práctica», no «3 capítulos», cuando el requisito es de un tipo de capítulo.
  const ck = (r.scope as { chapterKind?: 'practice' | 'content' }).chapterKind;
  const noun = (n: number) => nounOf(r.kind, n, r.evaluationType) + (r.kind === 'chapters' && ck && r.scope.level !== 'chapter' ? (ck === 'practice' ? ' de práctica' : ' de contenido') : '');
  if (a.each) {
    const e = a.each;
    if (!e.length) return 'ninguno';
    if (e.every((n) => n === e[0])) return `${n1(e[0])} ${noun(e[0])}${r.scope.level === 'chapter' ? ' por capítulo' : ' por módulo'}`;
    return `${r.scope.level === 'chapter' ? 'capítulos' : 'módulos'} con ${e.map(n1).join(', ')} ${noun(2)}`;
  }
  return typeof a.value === 'number' ? `${n1(a.value)} ${noun(a.value)}` : '—';
}

export interface ConflictContext {
  /** Estado del distribuidor (la estructura exigida puede pasarse de las horas, o no alcanzarlas). */
  status: string;
  /** Las horas de la meta las eligió el docente (entonces el choque con la estructura es su excepción). */
  hoursByTeacher?: boolean;
  /** Re-review L86C IMP-3: capítulos con video o Actividad de Aplicación fijados por el docente. */
  teacherPins?: boolean;
  /**
   * Re-review final L86C: causa de un choque de horas, calculada recalculando el diseño SIN las decisiones ni lo fijado
   * por el docente: 'teacher' (sin ellas desaparece, o la estructura del docente se aparta del documento) o 'document'
   * (persiste: dos requisitos del documento chocan). Sin cálculo (null) se trata como del documento.
   */
  clashCause?: 'teacher' | 'document' | null;
  /** La estructura la armó o editó el docente. */
  structureByTeacher?: boolean;
  /** Re-review final L86C: el requisito de videos que, sin el docente, solo se cumple chocando con las horas (y las horas de ese diseño). */
  clashWith?: { requirement: DocumentRequirement; hours: number } | null;
  baseHours: number;
  estimatedHours: number;
  /** Módulos del diseño (para explicar conflictos de evaluaciones y estructura). */
  modules: number;
  moduleExams: number;
  /** Excepciones de preferencias que el docente eligió (registradas o en «Ajustar» ahora). */
  exceptionFields: Partial<Record<ExceptionField, string>>;
}

/**
 * Comparaciones → checks de Verificación (área «Requisitos del documento»):
 *   cumple → ok · decidido por el docente → «Excepción al requisito del documento» (advertencia, no bloquea) ·
 *   lo decidió Cursia o la estructura y no se cumple → conflicto CRÍTICO con su causa · no se puede cumplir (p. ej. dos
 *   videos por capítulo) → crítico · no verificable (unidades, por resultado…) → info · recomendaciones → info.
 */
/** LOOP 9: lo que Cursia sí produce cuando el documento pide más de lo que puede (texto para la propuesta). */
export function capabilityProduces(r: DocumentRequirement, c?: RequirementCheck): string {
  // LOOP 9.2: un total que no cabe en la estructura exigida dice cuántos sí se producen.
  if (r.kind === 'videos' && r.scope.level === 'course' && c && typeof c.actual.value === 'number') return `Cursia produce un video por capítulo de contenido: ${c.actual.value} ${c.actual.value === 1 ? 'video' : 'videos'} en este curso`;
  return r.kind === 'videos' ? 'Cursia produce un video por capítulo'
    : r.kind === 'application_activities' ? 'Cursia produce una Actividad de Aplicación por capítulo'
      : r.kind === 'activities' ? 'Cursia produce una actividad interactiva por capítulo' : 'Cursia produce lo que permite su motor';
}

export function requirementVerificationChecks(applicable: DocumentRequirement[], checks: RequirementCheck[], ctx: ConflictContext): RequirementDesignCheck[] {
  const out: RequirementDesignCheck[] = [];
  const byId = new Map(applicable.map((r) => [r.id, r]));
  const has = (kind: string, et?: string) => applicable.find((r) => r.obligation === 'required' && r.confidence === 'high' && r.kind === kind && (!et || r.evaluationType === et));
  for (const c of checks) {
    const r = byId.get(c.requirementId);
    if (!r) continue;
    const id = `requirement:${r.id}`;
    const asked = requirementText(r);
    const has2 = actualText(r, c);
    // Review L86C I3: las horas del documento son la meta, así que «cumplen» por definición; pero si el diseño no puede
    // llegar a esas horas (la estructura exigida o los contenidos ya suman más, o no alcanzan sin rellenar) es un choque.
    const hoursClash = r.kind === 'target_hours' && r.scope.level === 'course' && r.obligation === 'required' && r.confidence === 'high' && !ctx.hoursByTeacher
      && (ctx.status === 'minimum_exceeds_target' || ctx.status === 'cannot_reach_target');
    // Review L86C I4: dos requisitos obligatorios del documento que se contradicen → conflicto en LOS DOS (aunque el
    // diseño cumpla uno por casualidad): Cursia no elige cuál manda.
    const twin0 = r.obligation === 'required' && r.confidence === 'high'
      ? applicable.find((o) => o.id !== r.id && o.obligation === 'required' && o.confidence === 'high' && o.kind === r.kind && JSON.stringify(o.scope) === JSON.stringify(r.scope)
        && (o.evaluationType || 'any') === (r.evaluationType || 'any') && !compatible(o, r))
      : undefined;
    if (twin0) {
      out.push({ id, area: 'requirements', severity: 'critical', title: `Conflicto con un requisito del documento: ${asked}`,
        detail: `El documento pide ${asked} y también «${requirementText(twin0)}»: no se pueden cumplir los dos. Cursia no elige entre ellos (el diseño tiene ${has2}): decide cuál aplica.`,
        ...(r.kind === 'target_hours' ? { fix: { kind: 'adjust' as const, action: 'targetHours', label: 'Elegir las horas' } } : { fix: { kind: 'editor' as const, action: 'structure', label: 'Resolver en el editor' } }) });
      continue;
    }
    if (c.status === 'met' && !hoursClash) {
      out.push({ id, area: 'requirements', severity: 'ok', title: `Requisito del documento: ${asked}` });
      continue;
    }
    // Re-review L86C IMP-3: si una decisión del docente limita cuánto puede crecer o achicarse el diseño (sin Actividades
    // de Aplicación, solo en prácticas, la prioridad audiovisual o capítulos fijados), el choque es SU excepción.
    const ef = ctx.exceptionFields || {};
    const teacherLimit = hoursClash && ctx.clashCause === 'teacher';
    if (teacherLimit) {
      const what = ef.applicationActivities === 'none' ? '«Actividades de Aplicación: Ninguna»' : ef.applicationActivities === 'practice_only' ? '«Actividades de Aplicación: Solo en prácticas»'
        : ef.audiovisual ? `la prioridad audiovisual que elegiste («${({ less: 'Menos video', recommended: 'Recomendado', more: 'Más video' } as Record<string, string>)[ef.audiovisual] || ef.audiovisual}»)`
          : ctx.teacherPins ? 'los videos o Actividades que fijaste a mano' : 'la estructura que armaste';
      const over = ctx.status === 'minimum_exceeds_target';
      const fix = ef.applicationActivities === 'none' || ef.applicationActivities === 'practice_only'
        ? { kind: 'adjust' as const, action: 'applicationActivities', value: 'requirement', label: 'Volver al requisito del documento' }
        : ef.audiovisual ? { kind: 'adjust' as const, action: 'audiovisual', value: 'requirement', label: 'Volver al requisito del documento' }
          : { kind: 'editor' as const, action: 'structure', label: 'Revisar lo fijado en el editor' };
      out.push({ id, area: 'requirements', severity: 'warning', title: `Excepción al requisito del documento: ${asked}`,
        detail: `Te estás apartando de un requisito del documento: con ${what}, el diseño ${over ? 'no puede bajar de' : 'no llega a'} ${asked} (≈ ${n1(over ? ctx.baseHours : ctx.estimatedHours)} h). Cursia respeta tu decisión.`, fix });
      continue;
    }
    if (hoursClash) {
      const st0 = has('structure') || has('chapters') || has('modules');
      const over = ctx.status === 'minimum_exceeds_target';
      const cause0 = ctx.clashWith
        ? ` Entra en conflicto con «${requirementText(ctx.clashWith.requirement)}»: para tener esos videos el diseño queda en ≈ ${n1(ctx.clashWith.hours)} h. No se pueden cumplir los dos; Cursia no elige entre ellos.`
        : st0
        ? ` Entra en conflicto con «${requirementText(st0)}»: ${over ? `esa estructura ya suma ≈ ${n1(ctx.baseHours)} h de trabajo del estudiante` : `con esa estructura el curso llega a ≈ ${n1(ctx.estimatedHours)} h sin rellenar`}.`
        : over ? ` Los contenidos del curso ya suman ≈ ${n1(ctx.baseHours)} h.` : ` Con los contenidos actuales el curso llega a ≈ ${n1(ctx.estimatedHours)} h sin rellenar.`;
      out.push({ id, area: 'requirements', severity: 'critical', title: `Conflicto con un requisito del documento: ${asked}`,
        detail: `El documento pide ${asked}; el diseño ${over ? 'no puede bajar de' : 'no llega a'} ${asked}.${cause0} Cursia no recorta ni rellena por su cuenta.`,
        fix: { kind: 'editor', action: 'structure', label: 'Resolver en el editor' } });
      continue;
    }
    if (r.obligation === 'required' && r.confidence !== 'high') {
      out.push({ id, area: 'requirements', severity: 'info', title: `Requisito del documento por revisar: ${asked}`,
        detail: `Cursia lo leyó con dudas («Revisa esta lectura»), así que no restringe el diseño.${c.status === 'unmet' ? ` El diseño tiene ${has2}.` : ''}` });
      continue;
    }
    if (r.obligation !== 'required') {
      out.push({ id, area: 'requirements', severity: 'info', title: `El documento ${r.obligation === 'permitted' ? 'permite' : 'recomienda'} ${asked}`, detail: c.status === 'unmet' ? `El diseño tiene ${has2}.` : c.note });
      continue;
    }
    if (c.status === 'not_verifiable') {
      // LOOP 9 (P0-2): lo que Cursia no puede producir (p. ej. 2 videos por capítulo) no puede quedar como un crítico sin
      // salida (la propuesta nunca se podría preparar). Es una excepción EXPLÍCITA: se ve aquí, la propuesta exige el motivo
      // de la institución antes de aprobarla y queda registrada en «Excepciones al documento». Nunca se calla.
      if (c.impossible) {
        // LOOP 9.2: otra excepción de capacidad del mismo tipo y de la misma frase (p. ej. «2 videos por capítulo de
        // contenido» para «8 videos») → un solo motivo para las dos.
        const twinCap = r.scope.level === 'course' ? checks.find((x) => x !== c && x.impossible && byId.get(x.requirementId) && byId.get(x.requirementId)!.kind === r.kind
          && byId.get(x.requirementId)!.scope.level !== 'course' && byId.get(x.requirementId)!.source.line === r.source.line && byId.get(x.requirementId)!.source.documentId === r.source.documentId) : undefined;
        const twinReq = twinCap ? byId.get(twinCap.requirementId)! : null;
        out.push({ id, area: 'requirements', severity: 'warning', title: `Excepción al requisito del documento: ${asked}`,
          detail: `${c.note || 'Cursia no puede producir lo que pide el documento.'} Queda como excepción: la propuesta pide el motivo de la institución antes de aprobarla.${twinReq ? ` Es la misma limitación que «${requirementText(twinReq)}»: un solo motivo cubre las dos.` : ''}`,
          // R68 la bloquea mientras no haya un motivo registrado (también fuera del flujo de propuesta: falla cerrada).
          capability: { requirementKey: String(r.key), requirementText: asked, produces: capabilityProduces(r, c), ...(twinReq ? { coveredBy: { requirementKey: String(twinReq.key), requirementText: requirementText(twinReq) } } : {}) } });
        continue;
      }
      out.push({ id, area: 'requirements', severity: 'info', title: `Requisito del documento por revisar: ${asked}`,
        detail: c.note || 'Cursia todavía no puede comprobarlo en el diseño.' });
      continue;
    }
    // Excepción: lo eligió el docente (no se revierte).
    if (c.chosenBy === 'teacher') {
      const fix = r.kind === 'target_hours' && typeof r.value === 'number'
        ? { kind: 'adjust' as const, action: 'targetHours', value: 'auto', label: 'Volver al requisito del documento' }
        : r.kind === 'videos' && ctx.exceptionFields.audiovisual ? { kind: 'adjust' as const, action: 'audiovisual', value: 'requirement', label: 'Volver al requisito del documento' }
          : r.kind === 'application_activities' && ctx.exceptionFields.applicationActivities ? { kind: 'adjust' as const, action: 'applicationActivities', value: 'requirement', label: 'Volver al requisito del documento' }
            : { kind: 'editor' as const, action: 'structure', label: 'Revisar en el editor' };
      out.push({ id, area: 'requirements', severity: 'warning', title: `Excepción al requisito del documento: ${asked}`,
        detail: `Te estás apartando de un requisito del documento: el documento pide ${asked}; elegiste ${has2}. Cursia respeta tu decisión.`, fix });
      continue;
    }
    // Review QA M1: el diseño se pasa de las horas del documento por una decisión del docente (estructura, fijados o
    // «Ajustar»): es SU excepción, no un conflicto del documento.
    const efs = ctx.exceptionFields || {};
    if (r.kind === 'target_hours' && ctx.status === 'above_tolerance' && (ctx.structureByTeacher || ctx.teacherPins || Object.keys(efs).length > 0)) {
      out.push({ id, area: 'requirements', severity: 'warning', title: `Excepción al requisito del documento: ${asked}`,
        detail: `Te estás apartando de un requisito del documento: con lo que decidiste en el diseño, el curso queda en ≈ ${n1(ctx.estimatedHours)} h (el documento pide ${asked}). Cursia respeta tu decisión.`,
        fix: { kind: 'adjust' as const, action: 'targetHours', label: 'Revisar las horas' } });
      continue;
    }
    // Conflicto: Cursia no lo resuelve sola. Se explica la causa cuando hay otro requisito que choca.
    let cause = '';
    const mods = has('modules');
    // Dos requisitos del propio documento que no pueden cumplirse a la vez (p. ej. «64 horas» y «40–44 horas»).
    const twin = applicable.find((o) => o.id !== r.id && o.obligation === 'required' && o.confidence === 'high' && o.kind === r.kind && JSON.stringify(o.scope) === JSON.stringify(r.scope)
      && (o.evaluationType || 'any') === (r.evaluationType || 'any') && !compatible(o, r));
    const st = has('structure') || has('chapters');
    if (twin) {
      cause = ` Entra en conflicto con otro requisito del mismo documento: «${requirementText(twin)}». Cursia no elige entre los dos: decide cuál aplica.`;
    } else if (r.kind === 'target_hours' && st && ctx.status === 'minimum_exceeds_target') {
      cause = ` Entra en conflicto con «${requirementText(st)}»: esa estructura ya suma ≈ ${n1(ctx.baseHours)} h de trabajo del estudiante.`;
    } else if (r.kind === 'target_hours' && st && ctx.status === 'cannot_reach_target') {
      cause = ` Entra en conflicto con «${requirementText(st)}»: con esa estructura el curso llega a ≈ ${n1(ctx.estimatedHours)} h sin rellenar.`;
    } else if (r.kind === 'target_hours' && ctx.status === 'above_tolerance') {
      const why = has('structure') || has('chapters') || has('application_activities') || has('activities');
      cause = ` Con ${why ? `lo que exige «${requirementText(why)}»` : 'la estructura y las actividades del diseño'} el curso queda en ≈ ${n1(ctx.estimatedHours)} h, por encima de la tolerancia. Cursia no quita capítulos ni actividades por su cuenta: decide si se ajustan las horas o la estructura.`;
    } else if (r.kind === 'evaluations' && r.evaluationType === 'partial' && mods && (mods.value as number) !== r.value) {
      cause = ` Entra en conflicto con «${requirementText(mods)}»: Cursia hace una evaluación por módulo; con ${n1(mods.value as number)} módulos no hay ${asked} sin que alguno quede sin evaluación (o con dos).`;
    } else if (c.note && /^El diseño no tiene módulo \d+/.test(c.note)) {
      cause = ` ${c.note} Cursia no agrega módulos por su cuenta.`;
    } else if ((r.kind === 'modules' || r.kind === 'structure') && c.chosenBy === 'cursia') {
      cause = ' Cursia no agrega ni quita módulos por su cuenta.';
    } else if (r.kind === 'chapters' || r.kind === 'structure') {
      cause = ' Cursia no quita capítulos existentes ni pasa del máximo por su cuenta.';
    } else if (r.kind === 'application_activities' && ctx.exceptionFields.applicationActivities === undefined) {
      cause = ' Con los capítulos del diseño no se pueden ubicar sin pasar los topes de cada capítulo.';
    }
    const fix = (r.kind === 'modules' || r.kind === 'chapters' || r.kind === 'structure' || r.kind === 'evaluations')
      ? { kind: 'editor' as const, action: r.kind === 'evaluations' ? 'module_exams' : 'structure', label: 'Resolver en el editor' }
      : r.kind === 'target_hours' ? { kind: 'adjust' as const, action: 'targetHours', label: 'Revisar las horas' } : undefined;
    out.push({ id, area: 'requirements', severity: 'critical', title: `Conflicto con un requisito del documento: ${asked}`,
      detail: `El documento pide ${asked}; el diseño tiene ${has2}.${cause}`, ...(fix ? { fix } : {}) });
  }
  return out;
}
