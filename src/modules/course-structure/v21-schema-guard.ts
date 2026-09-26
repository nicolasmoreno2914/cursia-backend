import { Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * V2.1 — fix round 1 (review G2 I5): guarda de esquema de las rutas de
 * estructura dinámica. El código V2.1 lee/escribe columnas que agrega
 * `supabase-migration-v21-blueprint-profiles.sql` (R3). Si el código llega a
 * una base sin esa migración (p.ej. producción antes de correr
 * scripts/prod/migrate-v2-production.js), las rutas responden 503
 * `schema_not_migrated_v21` con las columnas faltantes — nunca un 500 crudo
 * "column … does not exist" ni una lectura a medias.
 *
 * El resultado POSITIVO se cachea por proceso (una vez migrado, no vuelve
 * atrás); el negativo se re-consulta en cada request (la migración puede
 * correr con el proceso vivo). `probeV21StructureSchema` también se llama al
 * iniciar el módulo, solo para loguear fuerte.
 */
export const SCHEMA_NOT_MIGRATED_V21 = 'schema_not_migrated_v21';

export const V21_STRUCTURE_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'courses', column: 'final_exam_enabled' },
  { table: 'courses', column: 'activity_engine' },
  { table: 'course_chapters', column: 'activity_enabled' },
];

let verified = false;

export function _resetV21SchemaGuardForTests(): void {
  verified = false;
}

export async function missingV21StructureColumns(q: { query(sql: string, params?: any[]): Promise<any> }): Promise<string[]> {
  // TypeORM (DataSource/QueryRunner) devuelve el arreglo; un pg.Client, {rows}.
  const res: any = await q.query(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public' and (table_name, column_name) in (${V21_STRUCTURE_COLUMNS.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ')})`,
    V21_STRUCTURE_COLUMNS.flatMap((c) => [c.table, c.column]),
  );
  const rows: Array<{ table_name: string; column_name: string }> = Array.isArray(res) ? res : res.rows;
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  return V21_STRUCTURE_COLUMNS.map((c) => `${c.table}.${c.column}`).filter((k) => !have.has(k));
}

export async function assertV21StructureSchema(q: { query(sql: string, params?: any[]): Promise<any> }): Promise<void> {
  if (verified) return;
  const missing = await missingV21StructureColumns(q);
  if (missing.length > 0) {
    throw new ServiceUnavailableException({
      code: SCHEMA_NOT_MIGRATED_V21,
      message:
        `${SCHEMA_NOT_MIGRATED_V21}: la base no tiene la migración V2.1 R3 (supabase-migration-v21-blueprint-profiles.sql); ` +
        `faltan ${missing.join(', ')}. Correr la migración (scripts/prod/migrate-v2-production.js en producción) antes de usar el editor.`,
      missing,
    });
  }
  verified = true;
}

/** Sonda de arranque: solo loguea (fuerte) — las rutas ya fallan con 503 por su cuenta. */
export async function probeV21StructureSchema(q: { query(sql: string, params?: any[]): Promise<any> }, logger: Pick<Logger, 'error' | 'log'>): Promise<void> {
  try {
    const missing = await missingV21StructureColumns(q);
    if (missing.length > 0) {
      logger.error(`${SCHEMA_NOT_MIGRATED_V21}: faltan ${missing.join(', ')}; las rutas de estructura dinámica responderán 503 hasta migrar.`);
    }
  } catch (err) {
    logger.error(`${SCHEMA_NOT_MIGRATED_V21}: no se pudo sondear el esquema al iniciar (${err instanceof Error ? err.message : String(err)})`);
  }
}
