/**
 * R2 — Visual Components (vcSchemaVersion 1): LLM → JSON estricto → validador → renderer → HTML de label.
 *  - schema.ts       — tipos, VC_COMPONENT_SPECS, límites por movimiento
 *  - validate.ts     — validateExperience, validateComponent, lintResourceMentions, lintQuantityClaims
 *  - render.ts       — renderComponent, renderMovement (CLEAN_SAFE + ENHANCED)
 *  - lint-output.ts  — lintCleanSafe, extractText (+ parseHtml/parseStyle)
 */
export * from './schema';
export {
  validateExperience,
  validateComponent,
  assertValidExperience,
  lintResourceMentions,
  lintQuantityClaims,
  VcErrorCode,
  VcValidationError,
  VcValidationResult,
  VcTextLintHit,
} from './validate';
export { renderComponent, renderMovement, VcRenderContext, VcRenderLevel } from './render';
export {
  lintCleanSafe,
  extractText,
  parseHtml,
  parseStyle,
  decodeEntities,
  isCleanSafeProperty,
  CLEAN_SAFE_PROPERTIES,
  CleanSafeLintCode,
  CleanSafeLintError,
  CleanSafeLintResult,
  HtmlElement,
  HtmlNode,
  HtmlText,
  CssDecl,
} from './lint-output';
export { escapeHtml } from './text';
