// LOOP 8.1 · ¿La extracción gratuita leyó lo suficiente? Puro (lo prueba scripts/check-loop81-single-source.js).
// Suficiente = trae resultados de aprendizaje o unidades. Un PDF casi sin texto es un escaneo: solo la lectura
// avanzada (transcripción con IA, con costo y confirmación) puede leerlo.
// r70: un documento CON texto al que le faltan secciones no es un escaneo: se dice qué se encontró y qué falta, se
// ofrece completarlo a mano y se conserva lo encontrado (`partial`); la lectura avanzada solo se sugiere ante un escaneo.
import type { AcademicContextV1 } from './academic-context';

/** Menos caracteres por página que esto en un PDF = escaneo / imagen (una página de texto real tiene miles). */
export const SCANNED_CHARS_PER_PAGE = 80;

export type ExtractionIssueCode = 'SCANNED' | 'MISSING_ESSENTIALS';
export interface ExtractionIssue { code: ExtractionIssueCode; document: string | null; message: string }
export interface ExtractionQuality {
  sufficient: boolean;
  issues: ExtractionIssue[];
  /** La lectura avanzada puede ayudar: hay al menos un PDF sin capa de texto (escaneo / imagen). */
  advancedMayHelp: boolean;
  /** r70 · Lo que el documento SÍ trae (rótulos para el docente, p. ej. «nombre del curso», «60 horas»). */
  found: string[];
  /** r70 · Lo esencial que falta (p. ej. «resultados de aprendizaje», «unidades»). Vacío si es suficiente. */
  missing: string[];
  /**
   * r70 · No es suficiente, pero trae datos útiles (nombre, nivel, horas, objetivo…) de un documento con texto: el
   * borrador se puede guardar tal cual y completar a mano lo que falta (nunca se descarta lo encontrado).
   */
  partial: boolean;
}

const fmtH = (n: number) => String(n).replace('.', ',');

/** Rótulos de lo encontrado, en el orden en que el docente los ve. */
export function foundLabels(ctx: AcademicContextV1): string[] {
  const out: string[] = [];
  const id = ctx.identity;
  if (id.subjectName.status !== 'missing') out.push('nombre del curso');
  if (id.program.status !== 'missing') out.push('programa');
  if (id.educationLevel.status !== 'missing') out.push('nivel educativo');
  if (id.generalObjective.status !== 'missing') out.push('objetivo general');
  if (id.description.status !== 'missing') out.push('descripción');
  if (ctx.learner.profile.status !== 'missing') out.push('perfil del estudiante');
  if (ctx.hours.total.status !== 'missing' && typeof ctx.hours.total.value === 'number') out.push(`${fmtH(ctx.hours.total.value)} horas`);
  if (ctx.outcomes.length) out.push(ctx.outcomes.length === 1 ? '1 resultado de aprendizaje' : `${ctx.outcomes.length} resultados de aprendizaje`);
  if (ctx.competencies.length) out.push(ctx.competencies.length === 1 ? '1 competencia' : `${ctx.competencies.length} competencias`);
  if (ctx.units.length) out.push(ctx.units.length === 1 ? '1 unidad' : `${ctx.units.length} unidades`);
  if (ctx.methodology.status !== 'missing') out.push('metodología');
  if (ctx.evaluation.length) out.push('evaluación');
  if (ctx.bibliography.length) out.push('bibliografía');
  return out;
}

export function extractionQuality(ctx: AcademicContextV1): ExtractionQuality {
  const issues: ExtractionIssue[] = [];
  const scanned: string[] = [];
  for (const d of ctx.documents) {
    if (d.mediaType !== 'application/pdf') continue;
    const pages = d.pages && d.pages > 0 ? d.pages : 1;
    if (d.characters / pages < SCANNED_CHARS_PER_PAGE) {
      scanned.push(d.name);
      issues.push({ code: 'SCANNED', document: d.name, message: `«${d.name}» parece un documento escaneado: no tiene texto que podamos leer sin costo.` });
    }
  }
  const sufficient = ctx.outcomes.length > 0 || ctx.units.length > 0;
  const found = foundLabels(ctx);
  const missing = sufficient ? [] : ['resultados de aprendizaje', 'unidades'];
  const allScanned = ctx.documents.length > 0 && scanned.length === ctx.documents.length;
  const partial = !sufficient && !allScanned && found.length > 0;
  if (!sufficient) {
    const names = ctx.documents.map((d) => `«${d.name}»`);
    const docs = names.length === 1 ? names[0] : names.length ? 'los documentos' : 'el documento';
    const message = allScanned || !ctx.documents.length
      ? 'No encontramos resultados de aprendizaje ni unidades en el documento.'
      : found.length
        ? `Leímos ${docs} y encontramos: ${found.join(', ')}. No encontramos sus resultados de aprendizaje ni sus unidades temáticas: puedes completarlos a mano.`
        : `Leímos ${docs}, pero no reconocimos sus secciones (resultados de aprendizaje, unidades, horas…): puedes completar el curso a mano.`;
    issues.push({ code: 'MISSING_ESSENTIALS', document: null, message });
  }
  // La lectura avanzada (IA, con costo) solo ayuda a un PDF SIN capa de texto. A un PDF con texto al que le faltan
  // secciones no se le ofrece (ni se le dice que es «escaneado»).
  return { sufficient, issues, advancedMayHelp: scanned.length > 0, found, missing, partial };
}
