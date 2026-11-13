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
import { isUnevenShape, proposeShapedStructureFromContext, shapeChapterCounts, shapeLabel, SHAPE_INPUT_MAX } from '../academic-context/context-design';
import { documentContents } from '../academic-context/content-coverage';
import type { AcademicContextV1 } from '../academic-context/academic-context';
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
  // r109 M3b: con una forma desigual, «capítulos por módulo» se compara módulo a módulo (se dice el primero que no cumple).
  const counts = shapeChapterCounts(shape);
  const uneven = isUnevenShape(shape);
  for (const r of s.modules) {
    if (!meets(r, shape.modules)) out.push({ kind: 'modules', text: `El documento establece ${requirementText(r)} y has seleccionado ${plural(shape.modules, 'módulo', 'módulos')}.` });
  }
  for (const r of s.chapters) {
    if (!uneven) {
      if (!meets(r, shape.chaptersPerModule)) out.push({ kind: 'chapters', text: `El documento establece ${requirementText(r)} y has seleccionado ${plural(shape.chaptersPerModule, 'capítulo de contenido', 'capítulos de contenido')} por módulo.` });
    } else {
      const bad = counts.map((n, i) => ({ n, i })).filter((x) => !meets(r, x.n));
      if (bad.length) out.push({ kind: 'chapters', text: `El documento establece ${requirementText(r)} y has seleccionado ${shapeLabel(shape, { content: true })}: ${bad.length === 1 ? `el módulo ${bad[0].i + 1} no cumple` : `los módulos ${bad.map((x) => x.i + 1).join(', ')} no cumplen`}.` });
    }
  }
  for (const r of s.structure) {
    const ok = r.shape!.length === shape.modules && r.shape!.every((n, i) => n === counts[i]);
    if (!ok) out.push({ kind: 'structure', text: `El documento establece ${requirementText(r)} y has seleccionado ${shapeLabel(shape)}.` });
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

export interface ShapeRecommendation extends StructureShape {
  reason: string;
  /** r109 M3b: la forma es la del documento (un módulo por unidad, un capítulo por contenido). */
  fromDocument?: boolean;
}

/** «4 / 5 / 4 / 4». */
export function shapeSlashes(counts: number[]): string {
  return counts.join(' / ');
}

const validCounts = (c: number[] | null | undefined): c is number[] =>
  Array.isArray(c) && c.length >= 1 && c.length <= SHAPE_INPUT_MAX.modules && c.every((n) => Number.isInteger(n) && n >= 1 && n <= SHAPE_INPUT_MAX.chaptersPerModule);

/**
 * Lo que recomienda Cursia (dentro de lo que exige el documento):
 *   1. si el documento fija módulos y capítulos de contenido por módulo, esa forma;
 *   2. si el documento organiza sus contenidos en unidades, esa organización (cada unidad, un módulo);
 *   3. si no, el formato S/M/L más cercano a las horas (sin horas: M); lo que el documento fije (solo módulos o solo
 *      capítulos) se respeta.
 */
export function recommendShape(required: DocumentRequirement[], documentShape: number[] | null, targetHours: number | null, documentContents?: number[] | null): ShapeRecommendation {
  const s = structuralRequirements(required);
  const fixed = (rs: DocumentRequirement[]) => {
    const r = rs.find((x) => x.mode === 'exact' && typeof x.value === 'number');
    return r ? (r.value as number) : null;
  };
  const st = s.structure.find((r) => r.shape!.every((n) => n === r.shape![0]));
  const reqModules = fixed(s.modules) ?? (st ? st.shape!.length : null);
  const reqChapters = fixed(s.chapters) ?? (st ? st.shape![0] : null);
  if (reqModules && reqChapters) return { modules: reqModules, chaptersPerModule: reqChapters, reason: 'Es la estructura que exige el documento.' };
  // r109 M3b: una estructura desigual que EXIGE el documento («estructura 4, 5, 4, 4») es la recomendación, tal cual.
  const stUneven = !st && !reqChapters
    ? s.structure.find((r) => validCounts(r.shape) && r.shape!.some((n) => n !== r.shape![0]) && (reqModules === null || reqModules === r.shape!.length))
    : undefined;
  if (stUneven) {
    const mc = [...stUneven.shape!];
    return { modules: mc.length, chaptersPerModule: Math.max(...mc), moduleChapters: mc, reason: 'Es la estructura que exige el documento.' };
  }
  // r109 M3b: el documento organiza sus contenidos en unidades DESIGUALES (p. ej. 4 / 5 / 4 / 4) y no fija otra cantidad
  // de capítulos por módulo: se recomienda esa misma forma (cada unidad, un módulo; cada contenido, un capítulo) en vez de
  // emparejarla en N × M. Las formas parejas y los formatos S/M/L siguen como alternativas.
  if (validCounts(documentContents) && documentContents.some((n) => n !== documentContents[0]) && !reqChapters
    && (reqModules === null || reqModules === documentContents.length)) {
    const mc = [...documentContents];
    const n = mc.reduce((a, b) => a + b, 0);
    return {
      modules: mc.length, chaptersPerModule: Math.max(...mc), moduleChapters: mc, fromDocument: true,
      reason: `Como el documento: ${plural(mc.length, 'unidad', 'unidades')} con ${shapeSlashes(mc)} contenidos. Cada unidad es un módulo y cada uno de sus ${n} contenidos, un capítulo, en el orden del documento.`,
    };
  }
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

/**
 * r109 M3b · lo que recomienda Cursia y, si esa recomendación es la forma desigual del documento, la forma pareja que se
 * recomendaba antes (una alternativa más, junto a los formatos S/M/L y la personalizada).
 */
export function shapeRecommendations(required: DocumentRequirement[], documentShape: number[] | null, targetHours: number | null, documentContentsShape: number[] | null) {
  const recommended = recommendShape(required, documentShape, targetHours, documentContentsShape);
  let evenAlternative: ShapeRecommendation | null = null;
  if (recommended.moduleChapters) {
    const even = recommendShape(required, documentShape, targetHours);
    evenAlternative = even.moduleChapters ? null : { ...even, reason: `Forma pareja: ${even.modules} × ${even.chaptersPerModule}, con los contenidos del documento repartidos en orden.` };
  }
  return { recommended, evenAlternative };
}

/**
 * Fase 2/3 · vista previa de una forma (N × M o desigual): cómo quedan los contenidos del documento, cuántos quedan en
 * capítulos y en qué se aparta de lo que establece el documento. Función pura (la usa structurePreview y la prueba
 * scripts/r109/check-r109-uneven-shape.js).
 */
export function structurePreviewOf(context: AcademicContextV1 | null, required: DocumentRequirement[], shape: StructureShape, formatCode: CourseFormatCode | null) {
  const differences = shapeDifferences(required, shape, formatCode);
  const contents = context ? documentContents(context) : [];
  // r109 M3b: «4 módulos (4, 5, 4, 4 capítulos de contenido)» solo en la forma desigual (N × M: la respuesta de siempre).
  const label = shape.moduleChapters ? { label: shapeLabel(shape, { content: true }) } : {};
  if (!context || !contents.length) return { providersCalled: 0, shape, ...label, differences, plan: null, coverage: null, notes: [] as string[] };
  const p = proposeShapedStructureFromContext(context, shape);
  const assigned = p.modules.flatMap((m) => m.chapters.flatMap((c) => c.sourceContentIds));
  return {
    providersCalled: 0, shape, ...label, differences, notes: p.notes,
    plan: p.modules.map((m) => ({ title: m.title, chapters: m.chapters.map((c) => ({ title: c.title, contents: c.sourceContentIds.length, outcomeIds: c.outcomeIds })) })),
    coverage: { total: contents.length, assigned: new Set(assigned).size, duplicated: assigned.length - new Set(assigned).size },
  };
}
