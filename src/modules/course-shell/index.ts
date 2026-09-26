/**
 * R11a — Course Shell V2.1 (audit §E, §F, §M.3, §O):
 *  - facts.ts              — buildCourseFacts, factsNumberSet, lintShellNumbers
 *  - intro-schemas.ts      — course_intro / module_intro v3 (JSON LLM) + validadores
 *  - activity-type.ts      — activityTypeForChapter (rotación), validateH5pActivityPayload
 *  - final-exam.ts         — validateExamGift (parseGIFT, conteo, tope 40)
 *  - v3-validation.ts      — validación server-side por tipo de item v3 + datos del video
 *  - shell.ts              — labels del shell (CLEAN_SAFE + ENHANCED)
 *  - chapter-assembler.ts  — slots ordenados del capítulo según video/actividad
 *  - microcopy.ts          — transiciones determinísticas en español
 */
export * from './facts';
export * from './intro-schemas';
export * from './activity-type';
export * from './final-exam';
export * from './v3-validation';
export * from './shell';
export * from './chapter-assembler';
export * from './microcopy';
export { ShellRenderOptions, ShellLevel, injectIntoMovement } from './html';
