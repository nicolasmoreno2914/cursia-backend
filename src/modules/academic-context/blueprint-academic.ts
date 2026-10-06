/**
 * Fase 3 — forma del contexto académico CONGELADA en el Blueprint v2 (`course.academicContext`) y de los vínculos
 * de cada capítulo (`chapter.outcomeIds`).
 *
 * Sin imports a propósito (lo usa blueprint-snapshot.ts; este módulo no debe crear ciclos). Solo se congela lo que
 * cambia QUÉ se genera: los resultados de aprendizaje y competencias (con id, texto, nivel y dominio) y la huella del
 * contexto guardado. El resto del contexto (bibliografía, metodología, horas…) vive en su perfil versionado.
 *
 * Las claves existen SOLO con contexto (y en los capítulos con vínculos): los snapshots de siempre conservan su sha.
 */

export const ACADEMIC_BLUEPRINT_VERSION = 1 as const;
export const MAX_CHAPTER_OUTCOME_IDS = 8;
export const OUTCOME_REF_PATTERN = /^(RA|CO)[0-9]{1,3}$/;

export interface AcademicBlueprintOutcome {
  id: string;
  text: string;
  level: string | null;
  domain: 'know' | 'do';
}

export interface AcademicBlueprintContext {
  version: typeof ACADEMIC_BLUEPRINT_VERSION;
  /** sha256 del contexto académico guardado del que salió (trazabilidad: qué versión se congeló). */
  contextSha256: string;
  subjectName: string | null;
  outcomes: AcademicBlueprintOutcome[];
  competencies: { id: string; text: string }[];
}

function fail(path: string, msg: string): never {
  throw new Error(`BLUEPRINT_V2_INVALID_INPUT: ${path}: ${msg}`);
}
function text(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v.trim()) fail(path, `debe ser un texto no vacío (fue ${JSON.stringify(v)})`);
  return (v as string).replace(/\s+/g, ' ').trim();
}

/** Forma canónica (claves en orden fijo); null si no hay nada que congelar. Lanza ante un valor inválido. */
export function canonicalAcademicBlueprintContext(v: unknown): AcademicBlueprintContext | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) fail('academicContext', 'debe ser un objeto');
  const o = v as Record<string, unknown>;
  if (o.version !== ACADEMIC_BLUEPRINT_VERSION) fail('academicContext.version', `debe ser ${ACADEMIC_BLUEPRINT_VERSION}`);
  if (typeof o.contextSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.contextSha256)) fail('academicContext.contextSha256', 'debe ser hex de 64');
  if (!Array.isArray(o.outcomes) || !Array.isArray(o.competencies)) fail('academicContext', 'outcomes y competencies deben ser listas');
  const seen = new Set<string>();
  const id = (x: unknown, path: string, prefix: 'RA' | 'CO') => {
    if (typeof x !== 'string' || !OUTCOME_REF_PATTERN.test(x) || !x.startsWith(prefix)) fail(path, `id inválido ${JSON.stringify(x)}`);
    if (seen.has(x as string)) fail(path, `id repetido ${x}`);
    seen.add(x as string);
    return x as string;
  };
  const outcomes = (o.outcomes as unknown[]).map((x, i) => {
    const e = (x ?? {}) as Record<string, unknown>;
    const p = `academicContext.outcomes[${i}]`;
    if (e.level !== null && typeof e.level !== 'string') fail(`${p}.level`, 'debe ser texto o null');
    if (e.domain !== 'know' && e.domain !== 'do') fail(`${p}.domain`, 'debe ser know o do');
    return { id: id(e.id, `${p}.id`, 'RA'), text: text(e.text, `${p}.text`), level: (e.level as string | null) ?? null, domain: e.domain as 'know' | 'do' };
  });
  const competencies = (o.competencies as unknown[]).map((x, i) => {
    const e = (x ?? {}) as Record<string, unknown>;
    const p = `academicContext.competencies[${i}]`;
    return { id: id(e.id, `${p}.id`, 'CO'), text: text(e.text, `${p}.text`) };
  });
  if (!outcomes.length && !competencies.length) return null;
  const subject = o.subjectName === null || o.subjectName === undefined ? null : text(o.subjectName, 'academicContext.subjectName');
  return { version: ACADEMIC_BLUEPRINT_VERSION, contextSha256: o.contextSha256 as string, subjectName: subject, outcomes, competencies };
}

/**
 * Vínculos de un capítulo (columna course_chapters.outcome_ids o snapshot): undefined = sin vínculos (la clave no
 * entra al snapshot); 'invalid' = forma inválida. Acepta jsonb ya parseado o su texto.
 */
export function rawOutcomeIds(v: unknown): string[] | undefined | 'invalid' {
  if (v === undefined || v === null) return undefined;
  let a: unknown = v;
  if (typeof v === 'string') {
    try { a = JSON.parse(v); } catch { return 'invalid'; }
  }
  if (!Array.isArray(a) || a.length === 0 || a.length > MAX_CHAPTER_OUTCOME_IDS) return 'invalid';
  if (!a.every((x) => typeof x === 'string' && OUTCOME_REF_PATTERN.test(x))) return 'invalid';
  if (new Set(a).size !== a.length) return 'invalid';
  return a as string[];
}

/** Orden canónico de los vínculos: RA antes que CO, por número. */
export function sortOutcomeIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => (a.startsWith('RA') ? 0 : 1) - (b.startsWith('RA') ? 0 : 1) || Number(a.slice(2)) - Number(b.slice(2)));
}
