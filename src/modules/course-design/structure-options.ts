// Fase 2 · «¿Cómo quieres estructurar tu curso?» — las opciones y sus diferencias con el documento (funciones puras).
//
// DOCUMENTO = lo que pide la institución (requisitos obligatorios de módulos, capítulos de contenido por módulo, forma
// N × M, horas). DISEÑO = lo que la institución decide producir (la forma elegida). Esta pantalla NO bloquea: muestra la
// diferencia antes de aplicar («El documento establece 3 módulos y has seleccionado 4.»); al aplicar, la jerarquía de
// siempre la convierte en «Excepción al requisito del documento» con motivo obligatorio en la propuesta. Un documento sin
// estructura obligatoria no genera ninguna diferencia (Fase 2.3).

import type { DocumentRequirement } from '../academic-context/requirements/requirements';
import { BOX_DOCUMENT_ID, boxModuleTitlesFor } from '../academic-context/requirements/requirements-box';
import { requirementText } from '../academic-context/requirements/requirement-authority';
import { COURSE_FORMATS, CourseFormatCode } from '../prebrief/course-formats';
import { isUnevenShape, normalizeShape, proposeShapedStructureFromContext, shapeChapterCounts, shapeLabel, SHAPE_INPUT_MAX } from '../academic-context/context-design';
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

/** r109 M3c: quién lo establece — la caja «Requisitos obligatorios» del docente o el documento. */
const fromBox = (r: DocumentRequirement) => !!r.source && r.source.documentId === BOX_DOCUMENT_ID;
const establishes = (r: DocumentRequirement) => (fromBox(r) ? 'Tus requisitos establecen' : 'El documento establece');

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
    if (!meets(r, shape.modules)) out.push({ kind: 'modules', text: `${establishes(r)} ${requirementText(r)} y has seleccionado ${plural(shape.modules, 'módulo', 'módulos')}.` });
  }
  for (const r of s.chapters) {
    if (!uneven) {
      if (!meets(r, shape.chaptersPerModule)) out.push({ kind: 'chapters', text: `${establishes(r)} ${requirementText(r)} y has seleccionado ${plural(shape.chaptersPerModule, 'capítulo de contenido', 'capítulos de contenido')} por módulo.` });
    } else {
      const bad = counts.map((n, i) => ({ n, i })).filter((x) => !meets(r, x.n));
      if (bad.length) out.push({ kind: 'chapters', text: `${establishes(r)} ${requirementText(r)} y has seleccionado ${shapeLabel(shape, { content: true })}: ${bad.length === 1 ? `el módulo ${bad[0].i + 1} no cumple` : `los módulos ${bad.map((x) => x.i + 1).join(', ')} no cumplen`}.` });
    }
  }
  for (const r of s.structure) {
    const ok = r.shape!.length === shape.modules && r.shape!.every((n, i) => n === counts[i]);
    if (!ok) out.push({ kind: 'structure', text: `${establishes(r)} ${requirementText(r)} y has seleccionado ${shapeLabel(shape)}.` });
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
      if (!inRange) out.push({ kind: 'hours', text: `${establishes(r)} ${requirementText(r)} y el ${f.label} es de ${f.hoursMin}–${f.hoursMax} horas.` });
    }
  }
  return out;
}

export interface ShapeRecommendation extends StructureShape {
  reason: string;
  /** r109 M3c: la forma sale de la caja «Requisitos obligatorios» del docente («Viene de tus requisitos»). Ausente = como siempre. */
  origin?: 'teacher_box';
  /** r109 M3c: títulos de los módulos que escribió el docente (null = no dio título). */
  moduleTitles?: (string | null)[];
}

/** «4 / 5 / 4 / 4». */
export function shapeSlashes(counts: number[]): string {
  return counts.join(' / ');
}

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
  // r109 M3c: una estructura DESIGUAL escrita en la caja del docente es la forma recomendada tal cual (una desigual que
  // solo dice el documento sigue sin recomendarse: la recomienda «Como el documento», si cumple). Si se sale de los topes
  // de entrada no se recomienda (la verificación lo dice como conflicto crítico).
  const un = s.structure.find((r) => fromBox(r) && r.shape!.some((n) => n !== r.shape![0]));
  const unShape = un ? normalizeShape({ moduleChapters: un.shape }) : null;
  if (un && unShape && unShape.moduleChapters) {
    const mine = fromBox(un);
    return {
      ...unShape, reason: mine ? 'Es la estructura que escribiste en tus requisitos obligatorios.' : 'Es la estructura que exige el documento.',
      ...(mine ? { origin: 'teacher_box' as const, ...(un.moduleTitles && un.moduleTitles.some((t) => t) ? { moduleTitles: [...un.moduleTitles] } : {}) } : {}),
    };
  }
  const st = s.structure.find((r) => r.shape!.every((n) => n === r.shape![0]));
  const reqModules = fixed(s.modules) ?? (st ? st.shape!.length : null);
  const reqChapters = fixed(s.chapters) ?? (st ? st.shape![0] : null);
  if (reqModules && reqChapters) {
    // r109 M3c: si lo fijó la caja del docente, se dice («tus requisitos»); un documento: el texto de siempre.
    const mine = [...s.structure, ...s.modules, ...s.chapters].some(fromBox);
    const tit = mine && st && st.moduleTitles && st.moduleTitles.some((t) => t) ? { moduleTitles: [...st.moduleTitles] } : {};
    return mine ? { modules: reqModules, chaptersPerModule: reqChapters, reason: 'Es la estructura que escribiste en tus requisitos obligatorios.', origin: 'teacher_box', ...tit }
      : { modules: reqModules, chaptersPerModule: reqChapters, reason: 'Es la estructura que exige el documento.' };
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
 * r109 M3b · «Como el documento»: cada unidad del documento es un módulo y cada uno de sus contenidos, un capítulo, en
 * orden (sin el tope de 5 que usa el distribuidor al agregar). Es un campo APARTE de `recommended` (que sigue siendo la
 * recomendación pareja de siempre: un cliente anterior la ve idéntica). Se ofrece SOLO si el documento trae contenidos por
 * unidad y la forma cumple todo lo que el documento exige de módulos, capítulos por módulo (exacto, mínimo, máximo,
 * rango…) y estructura; si no, `documentRecommendation` es null y `note` dice por qué. Una estructura desigual exigida
 * solo por requisito (sin contenidos por unidad) no se ofrece aquí.
 */
export interface DocumentShapeRecommendation {
  modules: number;
  chaptersPerModule: number;
  /** Siempre presente (también si es pareja, p. ej. 7 / 7 / 7). */
  moduleChapters: number[];
  reason: string;
}
export function documentShapeRecommendation(
  context: AcademicContextV1 | null, required: DocumentRequirement[],
): { documentRecommendation: DocumentShapeRecommendation | null; note: string | null } {
  const none = (note: string | null) => ({ documentRecommendation: null, note });
  if (!context) return none(null);
  const units = context.units.filter((u) => u.contents.length > 0);
  if (!units.length) return none(null);
  const counts = units.map((u) => u.contents.length);
  const too = units.filter((u) => u.contents.length > SHAPE_INPUT_MAX.chaptersPerModule);
  if (too.length) {
    return none(`«Como el documento» no está disponible: ${too.length === 1 ? `la unidad ${too[0].id} trae ${too[0].contents.length} contenidos` : `las unidades ${too.map((u) => `${u.id} (${u.contents.length})`).join(', ')} traen más contenidos`} y un módulo admite hasta ${SHAPE_INPUT_MAX.chaptersPerModule} capítulos.`);
  }
  if (units.length > SHAPE_INPUT_MAX.modules) return none(`«Como el documento» no está disponible: el documento trae ${units.length} unidades con contenidos y un curso admite hasta ${SHAPE_INPUT_MAX.modules} módulos.`);
  const shape: StructureShape = { modules: counts.length, chaptersPerModule: Math.max(...counts), moduleChapters: counts };
  const diffs = shapeDifferences(required, shape);
  if (diffs.length) return none(`«Como el documento» (${shapeSlashes(counts)}) no cumple lo que exige el documento: ${diffs.map((d) => d.text.replace(/\.$/, '')).join('; ')}. Cursia recomienda la forma pareja.`);
  const total = counts.reduce((a, b) => a + b, 0);
  const skipped = context.units.length - units.length;
  return {
    documentRecommendation: {
      ...shape, moduleChapters: [...counts],
      reason: `Como el documento: ${plural(units.length, 'unidad', 'unidades')} con ${shapeSlashes(counts)} contenidos. Cada unidad es un módulo y cada uno de sus ${plural(total, 'contenido', 'contenidos')}, un capítulo, en el orden del documento.`
        + (skipped ? ` ${skipped === 1 ? 'Una unidad sin contenidos no se usa.' : `${skipped} unidades sin contenidos no se usan.`}` : ''),
    },
    note: null,
  };
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
  // r109 M3c: con la forma de la caja del docente, los módulos llevan los títulos que escribió.
  const titles = boxModuleTitlesFor(required, shapeChapterCounts(shape));
  const p = proposeShapedStructureFromContext(context, shape, titles ? { moduleTitles: titles } : undefined);
  const assigned = p.modules.flatMap((m) => m.chapters.flatMap((c) => c.sourceContentIds));
  return {
    providersCalled: 0, shape, ...label, differences, notes: p.notes,
    plan: p.modules.map((m) => ({ title: m.title, chapters: m.chapters.map((c) => ({ title: c.title, contents: c.sourceContentIds.length, outcomeIds: c.outcomeIds })) })),
    coverage: { total: contents.length, assigned: new Set(assigned).size, duplicated: assigned.length - new Set(assigned).size },
  };
}
