/**
 * R16 (rendimiento del empaque): corre `tasks` con a lo sumo `limit` en vuelo
 * y devuelve los resultados EN EL ORDEN de `tasks` (nunca en el de llegada).
 *
 * Errores — mismo resultado que correrlas una detrás de otra:
 *  - ante la primera falla no se arranca ninguna tarea nueva (fail fast);
 *  - se rechaza con el error de la tarea fallida de MENOR índice, apenas se
 *    sabe que es ésa (todas las anteriores ya terminaron bien). Como las tareas
 *    se arrancan en orden, las anteriores a una falla ya están en vuelo o
 *    terminadas: como mucho se espera a esas (≤ limit − 1), nunca a las que
 *    no arrancaron. Así el error es exactamente el que daba el loop secuencial
 *    (p. ej. un PackagingNotReadyError no se cambia por un error de red de un
 *    capítulo posterior).
 *  - los rechazos de tareas que siguen en vuelo después del rechazo se
 *    absorben (nunca un unhandledRejection).
 */
export async function runOrderedWithLimit<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number): Promise<T[]> {
  const n = tasks.length;
  const cap = Math.max(1, Math.floor(limit) || 1);
  const results: T[] = new Array(n);
  const state: Array<'pending' | 'running' | 'ok' | 'failed'> = new Array(n).fill('pending');
  const errors: unknown[] = new Array(n);
  if (n === 0) return results;

  return new Promise<T[]>((resolve, reject) => {
    let next = 0;
    let running = 0;
    let failed = false;
    let settled = false;
    let firstUnresolved = 0; // menor índice que todavía no terminó bien

    const advance = () => {
      if (settled) return;
      while (firstUnresolved < n && state[firstUnresolved] === 'ok') firstUnresolved++;
      if (firstUnresolved === n) {
        settled = true;
        resolve(results);
        return;
      }
      if (state[firstUnresolved] === 'failed') {
        settled = true;
        reject(errors[firstUnresolved]);
        return;
      }
      while (!failed && running < cap && next < n) start(next++);
    };

    const start = (i: number) => {
      state[i] = 'running';
      running++;
      let p: Promise<T>;
      try {
        p = Promise.resolve(tasks[i]());
      } catch (err) {
        p = Promise.reject(err);
      }
      p.then(
        (v) => {
          results[i] = v;
          state[i] = 'ok';
        },
        (err) => {
          errors[i] = err;
          state[i] = 'failed';
          failed = true;
        },
      ).then(() => {
        running--;
        advance();
      });
    };

    advance();
  });
}
