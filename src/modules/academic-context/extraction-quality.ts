// LOOP 8.1 · ¿La extracción gratuita leyó lo suficiente? Puro (lo prueba scripts/check-loop81-single-source.js).
// Suficiente = trae resultados de aprendizaje o unidades. Un PDF casi sin texto es un escaneo: solo la lectura
// avanzada (transcripción con IA, con costo y confirmación) puede leerlo.
import type { AcademicContextV1 } from './academic-context';

/** Menos caracteres por página que esto en un PDF = escaneo / imagen (una página de texto real tiene miles). */
export const SCANNED_CHARS_PER_PAGE = 80;

export type ExtractionIssueCode = 'SCANNED' | 'MISSING_ESSENTIALS';
export interface ExtractionIssue { code: ExtractionIssueCode; document: string | null; message: string }
export interface ExtractionQuality {
  sufficient: boolean;
  issues: ExtractionIssue[];
  /** La lectura avanzada puede ayudar (hay al menos un PDF y la extracción no fue suficiente o hay escaneos). */
  advancedMayHelp: boolean;
}

export function extractionQuality(ctx: AcademicContextV1): ExtractionQuality {
  const issues: ExtractionIssue[] = [];
  for (const d of ctx.documents) {
    if (d.mediaType !== 'application/pdf') continue;
    const pages = d.pages && d.pages > 0 ? d.pages : 1;
    if (d.characters / pages < SCANNED_CHARS_PER_PAGE) {
      issues.push({ code: 'SCANNED', document: d.name, message: `«${d.name}» parece un documento escaneado: no tiene texto que podamos leer sin costo.` });
    }
  }
  const sufficient = ctx.outcomes.length > 0 || ctx.units.length > 0;
  if (!sufficient) {
    issues.push({ code: 'MISSING_ESSENTIALS', document: null, message: 'No encontramos resultados de aprendizaje ni unidades en el documento.' });
  }
  const hasPdf = ctx.documents.some((d) => d.mediaType === 'application/pdf');
  return { sufficient, issues, advancedMayHelp: hasPdf && (!sufficient || issues.some((i) => i.code === 'SCANNED')) };
}
