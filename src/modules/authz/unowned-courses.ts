import { rbacMode } from './authz-flags';

/**
 * r75 B1 (H4 / D-26) · `ALLOW_UNOWNED_COURSES=true` volvía legible y escribible por CUALQUIER usuario todo curso con
 * `owner_id IS NULL` (y sus runs). Ahora:
 *   - solo tiene efecto con `NODE_ENV=development` y `CURSIA_RBAC_MODE≠enforce` (fuera de eso se ignora SIEMPRE, aunque
 *     el proceso haya arrancado: defensa en profundidad);
 *   - `assertUnownedCoursesSafe` (provider de AuthzModule, corre al iniciar la API y los workers) IMPIDE ARRANCAR con
 *     `ALLOW_UNOWNED_COURSES=true` fuera de `development`.
 * Todos los lectores del flag (courses, course-structure, course-blueprints, course-facts, change-impact) pasan por acá.
 */
export const UNOWNED_COURSES_UNSAFE = 'allow_unowned_courses_unsafe';

const isTrue = (v: unknown) => String(v ?? '').trim().toLowerCase() === 'true';
const isDevelopment = (env: NodeJS.ProcessEnv) => String(env.NODE_ENV ?? '').trim().toLowerCase() === 'development';

export function allowUnownedCourses(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTrue(env.ALLOW_UNOWNED_COURSES) && isDevelopment(env) && rbacMode(env) !== 'enforce';
}

export function assertUnownedCoursesSafe(env: NodeJS.ProcessEnv = process.env): void {
  if (isTrue(env.ALLOW_UNOWNED_COURSES) && !isDevelopment(env)) {
    throw new Error(
      `${UNOWNED_COURSES_UNSAFE}: ALLOW_UNOWNED_COURSES=true solo se admite con NODE_ENV=development ` +
        `(NODE_ENV=${JSON.stringify(String(env.NODE_ENV ?? ''))}). Con el flag, cualquier usuario lee y escribe los cursos sin dueño. ` +
        'Quita ALLOW_UNOWNED_COURSES del .env.',
    );
  }
}
