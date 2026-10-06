import { AcademicContextV1, academicContextSha256, normalizeAcademicContext } from './academic-context';
import { ACADEMIC_BLUEPRINT_VERSION, AcademicBlueprintContext } from './blueprint-academic';

/** Lo mínimo que necesita (DataSource o QueryRunner de TypeORM). */
export interface AcademicQueryExecutor {
  query(sql: string, params?: unknown[]): Promise<any>;
}

export interface StoredAcademicContext {
  version: number;
  context: AcademicContextV1;
  sha256: string;
}

/**
 * Fase 3 — contexto académico VIGENTE del curso (última versión de `course_profiles` con kind 'academic'), o null si
 * nunca se guardó (o la base no tiene la migración: no hay filas → null, el comportamiento de siempre). Lectura
 * verificada contra su sha256 (falla fuerte si no coincide, igual que el perfil pedagógico).
 */
export async function loadCurrentAcademicContext(q: AcademicQueryExecutor, courseId: number): Promise<StoredAcademicContext | null> {
  const [row] = await q.query(
    `select id, version, data, sha256 from public.course_profiles where course_id = $1 and kind = 'academic' order by version desc limit 1`,
    [courseId],
  );
  return row ? parseStoredAcademicContext(row, courseId) : null;
}

export function parseStoredAcademicContext(row: { id: unknown; version: unknown; data: unknown; sha256: unknown }, courseId: number): StoredAcademicContext {
  const stored = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  const context = normalizeAcademicContext(stored);
  const sha = academicContextSha256(context);
  if (sha !== row.sha256) {
    throw new Error(`Contexto académico #${row.id} (v${row.version}) del curso #${courseId}: el contenido no coincide con su sha256 (integridad rota)`);
  }
  return { version: Number(row.version), context, sha256: sha };
}

/** Lo que el Blueprint congela de un contexto guardado (null sin resultados ni competencias: nada que congelar). */
export function academicBlueprintContext(ctx: AcademicContextV1 | null, sha256?: string): AcademicBlueprintContext | null {
  if (!ctx || (!ctx.outcomes.length && !ctx.competencies.length)) return null;
  return {
    version: ACADEMIC_BLUEPRINT_VERSION,
    contextSha256: sha256 ?? academicContextSha256(ctx),
    subjectName: ctx.identity.subjectName.value ?? null,
    outcomes: ctx.outcomes.map((o) => ({ id: o.id, text: o.text, level: o.level, domain: o.domain })),
    competencies: ctx.competencies.map((c) => ({ id: c.id, text: c.text })),
  };
}
