// Fase 2 · «¿Cómo quieres estructurar tu curso?» — las opciones y sus diferencias con el documento (funciones puras).
//
// DOCUMENTO = lo que pide la institución (requisitos obligatorios de módulos, capítulos de contenido por módulo, forma
// N × M, horas). DISEÑO = lo que la institución decide producir (la forma elegida). Esta pantalla NO bloquea: muestra la
// diferencia antes de aplicar («El documento establece 3 módulos y has seleccionado 4.»); al aplicar, la jerarquía de
// siempre la convierte en «Excepción al requisito del documento» con motivo obligatorio en la propuesta. Un documento sin
// estructura obligatoria no genera ninguna diferencia (Fase 2.3).

import type { DocumentRequirement } from '../academic-context/requirements/requirements';
import { requirementText } from '../academic-context/requirements/requirement-authority';
import { COURSE_FORMATS, CourseFormatCode } from '../prebrief/course-formats';
import type { StructureShape } from '../academic-context/context-design';

export interface StructureDifference {
  /** 'modules' | 'chapters' | 'structure' | 'hours' */
  kind: string;
  text: string;
}

const isStrict = (r: DocumentRequirement) => r.obligation === 'required' && r.confidence === 'high' && r.active !== false && (r as { applies?: boolean }).applies !== false;

function meets(r: DocumentRequirement, v: number): boolean {
  const x = r.value as number;
  switch (r.mode) {
    case 'exact': return v === x;
    case 'min': return v >= x;
    case 'max': return v <= x;
    case 'range': return v >= x && v <= (r.valueMax ?? x);
    case 'approx': return Math.abs(v - x) <= Math.max(1, 0.1 * x);
    default: return true;
  }
}

/** Requisitos del documento que fijan la forma: módulos del curso, capítulos (de contenido) por módulo, forma N × M. */
export function structuralRequirements(required: DocumentRequirement[]) {
  const strict = required.filter(isStrict);
  return {
    modules: strict.filter((r) => r.kind === 'modules' && r.scope.level === 'course' && typeof r.value === 'number'),
    chapters: strict.filter((r) => r.kind === 'chapters' && r.scope.level === 'module' && 'each' in r.scope && (r.scope as { chapterKind?: string }).chapterKind !== 'practice' && typeof r.value === 'number'),
    structure: strict.filter((r) => r.kind === 'structure' && Array.isArray(r.shape) && r.shape.length > 0),
    hours: strict.filter((r) => r.kind === 'target_hours' && r.scope.level === 'course' && typeof r.value === 'number'),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Diferencias entre lo que establece el documento y la forma elegida (y, si es un formato, sus horas). Vacío = la forma
 * cumple lo que el documento exige (o el documento no exige una forma).
 */
export function shapeDifferences(required: DocumentRequirement[], shape: StructureShape, formatCode?: CourseFormatCode | null): StructureDifference[] {
  const s = structuralRequirements(required);
  const out: StructureDifference[] = [];
  for (const r of s.modules) {
    if (!meets(r, shape.modules)) out.push({ kind: 'modules', text: `El documento establece ${requirementText(r)} y has seleccionado ${plural(shape.modules, 'módulo', 'módulos')}.` });
  }
  for (const r of s.chapters) {
    if (!meets(r, shape.chaptersPerModule)) out.push({ kind: 'chapters', text: `El documento establece ${requirementText(r)} y has seleccionado ${plural(shape.chaptersPerModule, 'capítulo de contenido', 'capítulos de contenido')} por módulo.` });
  }
  for (const r of s.structure) {
    const ok = r.shape!.length === shape.modules && r.shape!.every((n) => n === shape.chaptersPerModule);
    if (!ok) out.push({ kind: 'structure', text: `El documento establece ${requirementText(r)} y has seleccionado ${shape.modules} × ${shape.chaptersPerModule}.` });
  }
  const f = formatCode ? COURSE_FORMATS[formatCode] : null;
  if (f) {
    for (const r of s.hours) {
      const v = r.value as number;
      // Exacto: el número del documento cae dentro del formato; rango: se superponen; mínimo/máximo/aproximado: la meta
      // del formato (su punto medio) cumple el requisito.
      const inRange = r.mode === 'exact' ? v >= f.hoursMin && v <= f.hoursMax
        : r.mode === 'range' ? (r.valueMax ?? v) >= f.hoursMin && v <= f.hoursMax
          : meets(r, f.targetHours);
      if (!inRange) out.push({ kind: 'hours', text: `El documento establece ${requirementText(r)} y el ${f.label} es de ${f.hoursMin}–${f.hoursMax} horas.` });
    }
  }
  return out;
}

export interface ShapeRecommendation extends StructureShape { reason: string }

/**
 * Lo que recomienda Cursia (dentro de lo que exige el documento):
 *   1. si el documento fija módulos y capítulos de contenido por módulo, esa forma;
 *   2. si el documento organiza sus contenidos en unidades, esa organización (cada unidad, un módulo);
 *   3. si no, el formato S/M/L más cercano a las horas (sin horas: M); lo que el documento fije (solo módulos o solo
 *      capítulos) se respeta.
 */
export function recommendShape(required: DocumentRequirement[], documentShape: number[] | null, targetHours: number | null): ShapeRecommendation {
  const s = structuralRequirements(required);
  const fixed = (rs: DocumentRequirement[]) => {
    const r = rs.find((x) => x.mode === 'exact' && typeof x.value === 'number');
    return r ? (r.value as number) : null;
  };
  const st = s.structure.find((r) => r.shape!.every((n) => n === r.shape![0]));
  const reqModules = fixed(s.modules) ?? (st ? st.shape!.length : null);
  const reqChapters = fixed(s.chapters) ?? (st ? st.shape![0] : null);
  if (reqModules && reqChapters) return { modules: reqModules, chaptersPerModule: reqChapters, reason: 'Es la estructura que exige el documento.' };
  if (documentShape && documentShape.length) {
    // Hacia abajo: nunca más capítulos que contenidos (Cursia no inventa capítulos de «profundización» al recomendar).
    const modules = reqModules ?? documentShape.length;
    const per = Math.max(1, Math.floor(documentShape.reduce((a, b) => a + b, 0) / modules));
    return {
      modules,
      chaptersPerModule: reqChapters ?? (modules === documentShape.length && documentShape.every((n) => n === documentShape[0]) ? documentShape[0] : per),
      reason: `Sigue la organización del documento: un módulo por unidad (${plural(documentShape.length, 'unidad', 'unidades')}).`,
    };
  }
  const code: CourseFormatCode = typeof targetHours === 'number' ? (targetHours <= 26 ? 'S' : targetHours <= 52 ? 'M' : 'L') : 'M';
  const f = COURSE_FORMATS[code];
  return {
    modules: reqModules ?? f.modules,
    chaptersPerModule: reqChapters ?? f.chaptersPerModule,
    reason: typeof targetHours === 'number' ? `Para ${String(targetHours).replace('.', ',')} h, la forma del ${f.label} reparte bien el trabajo.` : `La forma del ${f.label}, la más usada.`,
  };
}
