export * from './academic-context';
export * from './academic-db';
export * from './blueprint-academic';
export * from './bloom';
export * from './context-design';
export * from './validate';
export { extractAcademicContext, mergeExtractions, refsOf, EXTRACTOR_ID, EXTRACTOR_VERSION } from './extract/extractor';
export type { ExtractionNote, ExtractionResult, ExtractionInput } from './extract/extractor';
export { readDocument, sniffMediaType, DocumentReadError } from './extract/text-sources';
