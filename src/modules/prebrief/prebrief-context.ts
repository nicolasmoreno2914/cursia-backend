import { CONTEXT_STRING_FIELDS, REQUIRED_CONTEXT_FIELDS } from '../dynamic-generation/run-hash';

/**
 * Campos del contexto de generación que congela el Prebrief: EXACTAMENTE los campos de texto que el run congela
 * (run-hash.ts). Se importan de ahí para que un campo nuevo del contexto entre solo en la huella del Prebrief (la prueba
 * de cobertura lo verifica). `prevCourse` y `scormTemplateIds` no se aprueban: en un curso con Prebrief el servidor no
 * los toma del navegador (no hay «continuar desde otro curso» en V2 y el motor de actividades lo fija el Blueprint).
 */
export const PREBRIEF_CONTEXT_FIELDS: readonly string[] = CONTEXT_STRING_FIELDS;
export const PREBRIEF_REQUIRED_CONTEXT_FIELDS: readonly string[] = REQUIRED_CONTEXT_FIELDS;
