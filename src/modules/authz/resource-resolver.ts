import { columnExists, isUuid, numericCourseId, QueryFn } from './schema-probe';

/**
 * r75 · Recurso → curso → institución y dueño técnico (01 §3.3). Todas las comparaciones contra columnas legacy usan
 * `::text` en AMBOS lados (deriva de prod: `production_jobs.owner_id uuid`, `production_jobs.course_id text`,
 * `artifacts.owner_id uuid`; ver 00 §5 / D-2). Puro sobre un `QueryFn` (testeable con PG descartable).
 */
export interface ResolvedCourse {
  courseId: number;
  ownerId: string | null;
  institutionId: string | null;
}

export interface ResolvedRun extends Partial<ResolvedCourse> {
  runId: string;
  runOwnerId: string | null;
  startedBy: string | null;
  course: ResolvedCourse | null;
}

export interface ResolvedArtifact {
  artifactId: string;
  ownerId: string | null;
  rawCourseId: string | null;
  jobId: string | null;
  course: ResolvedCourse | null;
}

export interface ResolvedInstitution {
  institutionId: string;
  status: string;
  kind: string | null;
}

const asText = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export async function resolveCourse(query: QueryFn, rawCourseId: unknown): Promise<ResolvedCourse | null> {
  const id = numericCourseId(rawCourseId);
  if (id === null) return null;
  const [row] = await query(
    `select id, owner_id::text as owner_id, institution_id::text as institution_id from public.courses where id = $1`,
    [id],
  );
  return row ? { courseId: Number(row.id), ownerId: asText(row.owner_id), institutionId: asText(row.institution_id) } : null;
}

/**
 * Curso por la referencia que guardan artifacts / jobs legacy / eventos: id numérico, o el UUID del frontend
 * (`courses.metadata->>'courseId'`). Con UUID puede haber varias filas (gemelo V2 de un legacy, o — de forma
 * maliciosa — el mismo UUID en cursos de dueños distintos): `preferOwner` elige la del dueño indicado si existe.
 */
export async function resolveCourseRef(query: QueryFn, raw: unknown, preferOwner?: string | null): Promise<ResolvedCourse[]> {
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!s) return [];
  const id = numericCourseId(s);
  if (id !== null) {
    const c = await resolveCourse(query, id);
    return c ? [c] : [];
  }
  const rows = await query(
    `select id, owner_id::text as owner_id, institution_id::text as institution_id
       from public.courses where metadata->>'courseId' = $1
      order by (owner_id::text = coalesce($2::text, '')) desc, id asc limit 20`,
    [s, preferOwner ?? null],
  );
  return rows.map((r: any) => ({ courseId: Number(r.id), ownerId: asText(r.owner_id), institutionId: asText(r.institution_id) }));
}

export async function resolveRun(query: QueryFn, rawRunId: unknown): Promise<ResolvedRun | null> {
  if (!isUuid(rawRunId)) return null;
  const [row] = await query(
    `select pj.id::text as run_id, pj.owner_id::text as run_owner, pj.input_payload->>'startedBy' as started_by,
            c.id as course_id, c.owner_id::text as course_owner, c.institution_id::text as institution_id
       from public.production_jobs pj
       left join public.courses c on c.id::text = pj.course_id::text
      where pj.id::text = $1`,
    [String(rawRunId).trim().toLowerCase()],
  );
  if (!row) return null;
  const course = row.course_id !== null && row.course_id !== undefined
    ? { courseId: Number(row.course_id), ownerId: asText(row.course_owner), institutionId: asText(row.institution_id) }
    : null;
  return { runId: row.run_id, runOwnerId: asText(row.run_owner), startedBy: asText(row.started_by), course, ...(course ?? {}) };
}

export async function resolveArtifact(query: QueryFn, rawArtifactId: unknown): Promise<ResolvedArtifact | null> {
  if (!isUuid(rawArtifactId)) return null;
  const [row] = await query(
    `select id::text as id, owner_id::text as owner_id, course_id::text as course_id, job_id::text as job_id
       from public.artifacts where id::text = $1`,
    [String(rawArtifactId).trim().toLowerCase()],
  );
  if (!row) return null;
  const owner = asText(row.owner_id);
  // El curso del artifact: el que coincide con su referencia Y es del dueño del artifact (los artifacts siempre se
  // escriben en la carpeta del dueño del curso; una referencia a un curso ajeno no da acceso a nada).
  const matches = await resolveCourseRef(query, row.course_id, owner);
  const course = matches.find((c) => c.ownerId && owner && c.ownerId === owner) ?? null;
  return { artifactId: row.id, ownerId: owner, rawCourseId: asText(row.course_id), jobId: asText(row.job_id), course };
}

export async function resolveInstitution(query: QueryFn, rawInstitutionId: unknown): Promise<ResolvedInstitution | null> {
  if (!isUuid(rawInstitutionId)) return null;
  const hasStatus = await columnExists(query, 'institutions', 'status');
  const hasKind = await columnExists(query, 'institutions', 'kind');
  const [row] = await query(
    `select id::text as id${hasStatus ? ', status' : ''}${hasKind ? ', kind' : ''} from public.institutions where id::text = $1`,
    [String(rawInstitutionId).trim().toLowerCase()],
  );
  if (!row) return null;
  return { institutionId: row.id, status: hasStatus ? String(row.status ?? 'active') : 'active', kind: hasKind ? asText(row.kind) : null };
}
