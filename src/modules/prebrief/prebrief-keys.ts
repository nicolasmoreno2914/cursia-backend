/**
 * Claves de courses.metadata del Prebrief. Solo las escribe el servicio del Prebrief: CoursesService.update las protege
 * (un PATCH del curso nunca las cambia ni las borra — review BE-1 C1: borrar `approvalFlow` apagaba la barrera).
 */
export const APPROVAL_FLOW_KEY = 'approvalFlow';
export const EXCEPTION_REASONS_KEY = 'requirementExceptionReasons';
export const CONFIRMATIONS_KEY = 'prebriefConfirmations';
export const COURSE_FORMAT_METADATA_KEY = 'courseFormat';
export const PREBRIEF_METADATA_KEYS = [APPROVAL_FLOW_KEY, EXCEPTION_REASONS_KEY, CONFIRMATIONS_KEY, COURSE_FORMAT_METADATA_KEY] as const;
