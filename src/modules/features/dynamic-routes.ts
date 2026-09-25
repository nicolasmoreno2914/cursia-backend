import { CourseStructureController } from '../course-structure/course-structure.controller';
import { CourseBlueprintsController } from '../course-blueprints/course-blueprints.controller';
import { GenerationManifestsController } from '../generation-manifests/generation-manifests.controller';
import { RunsController } from '../dynamic-generation/runs.controller';
import { ExecutorController } from '../dynamic-generation/executor.controller';
import { PackagingController } from '../dynamic-packaging/packaging.controller';
import { CoursesController } from '../courses/courses.controller';

/**
 * Rutas de la estructura dinámica de cursos (V2) que DynamicFeatureGuard
 * esconde (404) con DYNAMIC_COURSE_STRUCTURE apagado. Se listan acá (un solo
 * archivo) en vez de decorar los controllers.
 *
 * - Controllers enteros: todas sus rutas son V2.
 * - Handlers sueltos: rutas V2 dentro de un controller legacy.
 *
 * `course-setup` (extracción de "Datos del curso" desde PDF) NO se incluye:
 * no crea ni toca datos dynamic.
 */
export const DYNAMIC_CONTROLLERS: ReadonlySet<Function> = new Set<Function>([
  CourseStructureController,
  CourseBlueprintsController,
  GenerationManifestsController,
  RunsController,
  ExecutorController,
  PackagingController,
]);

export const DYNAMIC_HANDLERS: ReadonlySet<Function> = new Set<Function>([
  CoursesController.prototype.createOrGetDynamic, // POST /courses/dynamic
]);

export function isDynamicRoute(controllerClass: Function | undefined, handler: Function | undefined): boolean {
  return (!!controllerClass && DYNAMIC_CONTROLLERS.has(controllerClass)) || (!!handler && DYNAMIC_HANDLERS.has(handler));
}
