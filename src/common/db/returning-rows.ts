/**
 * Filas devueltas por un `UPDATE ... RETURNING` / `DELETE ... RETURNING`
 * ejecutado con `queryRunner.query()`.
 *
 * Con el driver de Postgres de TypeORM (0.3.x), `query()` NO devuelve las
 * filas para UPDATE/DELETE: devuelve `[rows, rowCount]`
 * (PostgresQueryRunner.query → `result.raw = [raw.rows, raw.rowCount]`).
 * Para SELECT/INSERT sí devuelve `rows` directo. Leer `result[0].col` en un
 * UPDATE daba `undefined` (el counter nunca llegaba al cliente) y
 * `result.length === 0` en un DELETE nunca era cierto (siempre largo 2).
 * Acepta ambas formas por si una versión futura del driver cambia.
 */
export function returningRows(result: any): any[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0];
  }
  return result;
}
