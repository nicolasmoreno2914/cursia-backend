import { PedagogicalProfile, normalizePedagogicalProfile, pedagogicalProfileSha256 } from './pedagogy-profile';

/** Lo mínimo que necesita (DataSource o QueryRunner de TypeORM). */
export interface PedagogyQueryExecutor {
  query(sql: string, params?: unknown[]): Promise<any>;
}

export interface StoredPedagogicalProfile {
  version: number;
  profile: PedagogicalProfile;
  sha256: string;
}

/**
 * Motor pedagógico V1 — perfil pedagógico VIGENTE del curso (última versión de
 * `course_profiles` con kind 'pedagogy'), o null si nunca se guardó. Lectura
 * verificada: si el contenido no coincide con su sha256 falla fuerte (igual
 * que CourseProfilesService.toDto). Sin la migración aplicada simplemente no
 * hay filas 'pedagogy' → null (comportamiento de siempre).
 */
export async function loadCurrentPedagogicalProfile(q: PedagogyQueryExecutor, courseId: number): Promise<StoredPedagogicalProfile | null> {
  const [row] = await q.query(
    `select id, version, data, sha256 from public.course_profiles where course_id = $1 and kind = 'pedagogy' order by version desc limit 1`,
    [courseId],
  );
  if (!row) return null;
  return parseStoredPedagogicalProfile(row, courseId);
}

/** Fila de course_profiles (id, version, data, sha256) → perfil normalizado y verificado contra su sha. */
export function parseStoredPedagogicalProfile(row: { id: unknown; version: unknown; data: unknown; sha256: unknown }, courseId: number): StoredPedagogicalProfile {
  const stored = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  const profile = normalizePedagogicalProfile(stored);
  const sha = pedagogicalProfileSha256(profile);
  if (sha !== row.sha256) {
    throw new Error(`Perfil pedagógico #${row.id} (v${row.version}) del curso #${courseId}: el contenido no coincide con su sha256 (integridad rota)`);
  }
  return { version: Number(row.version), profile, sha256: sha };
}
