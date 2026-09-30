/**
 * EV6 — secciones Moodle del curso v3 (una sección por página, `coursedisplay` = 1).
 *
 * Función PURA compartida por el plan de empaquetado (Manifest + Blueprint) y por el shell
 * (facts): los dos derivan los MISMOS números de sección de la misma estructura, así los
 * botones «Continuar…» del capítulo (que el shell escribe como `cursia-cta://section/N`)
 * apuntan a la sección que el builder crea.
 *
 *   0                 Bienvenida
 *   1                 Ruta de aprendizaje y Libro Guía
 *   por módulo m:
 *     una por capítulo  «Módulo m · Capítulo n: título» (la presentación del módulo va arriba
 *                       de la sección de su PRIMER capítulo)
 *     si m tiene examen «Módulo m · Evaluación»
 *   si hay examen final «Evaluación final»
 *   última             «Cierre del curso» (siempre DESPUÉS del examen final)
 */
import type { CourseFacts } from './facts';

export type SectionKindV3 = 'shell' | 'route_and_book' | 'chapter' | 'module_exam' | 'final_exam' | 'closing';

export interface SectionEntryV3 {
  sectionNum: number;
  kind: SectionKindV3;
  moduleId?: string;
  chapterId?: string;
  title: string;
}

export interface SectionLayoutInputV3 {
  modules: Array<{
    id: string;
    number: number;
    examEnabled: boolean;
    chapters: Array<{ id: string; number: number; title: string }>;
  }>;
  finalExam: boolean;
}

export interface SectionLayoutV3 {
  sections: SectionEntryV3[];
  /** chapterId → sección del capítulo. */
  chapterSection: Record<string, number>;
  /** moduleId → sección de su primer capítulo (donde va la presentación del módulo). */
  moduleFirstSection: Record<string, number>;
  /** moduleId → sección de su evaluación (solo módulos con examen). */
  examSection: Record<string, number>;
  finalExamSection: number | null;
  closingSection: number;
}

export const SECTION_TITLE_WELCOME = 'Bienvenida';
export const SECTION_TITLE_ROUTE = 'Ruta de aprendizaje y Libro Guía';
export const SECTION_TITLE_FINAL_EXAM = 'Evaluación final';
export const SECTION_TITLE_CLOSING = 'Cierre del curso';

export function chapterSectionTitle(moduleNumber: number, chapterNumber: number, title: string): string {
  return `Módulo ${moduleNumber} · Capítulo ${chapterNumber}: ${title}`;
}

export function moduleExamSectionTitle(moduleNumber: number): string {
  return `Módulo ${moduleNumber} · Evaluación`;
}

export function sectionLayoutV3(input: SectionLayoutInputV3): SectionLayoutV3 {
  const sections: SectionEntryV3[] = [
    { sectionNum: 0, kind: 'shell', title: SECTION_TITLE_WELCOME },
    { sectionNum: 1, kind: 'route_and_book', title: SECTION_TITLE_ROUTE },
  ];
  const chapterSection: Record<string, number> = {};
  const moduleFirstSection: Record<string, number> = {};
  const examSection: Record<string, number> = {};
  let n = 2;
  for (const m of input.modules) {
    if (!m.chapters.length) throw new Error(`SECTION_LAYOUT_INVALID: el módulo ${m.number} no tiene capítulos`);
    for (const ch of m.chapters) {
      if (chapterSection[ch.id] !== undefined) throw new Error(`SECTION_LAYOUT_INVALID: capítulo ${ch.id} repetido`);
      chapterSection[ch.id] = n;
      if (moduleFirstSection[m.id] === undefined) moduleFirstSection[m.id] = n;
      sections.push({ sectionNum: n++, kind: 'chapter', moduleId: m.id, chapterId: ch.id, title: chapterSectionTitle(m.number, ch.number, ch.title) });
    }
    if (m.examEnabled) {
      examSection[m.id] = n;
      sections.push({ sectionNum: n++, kind: 'module_exam', moduleId: m.id, title: moduleExamSectionTitle(m.number) });
    }
  }
  let finalExamSection: number | null = null;
  if (input.finalExam) {
    finalExamSection = n;
    sections.push({ sectionNum: n++, kind: 'final_exam', title: SECTION_TITLE_FINAL_EXAM });
  }
  const closingSection = n;
  sections.push({ sectionNum: closingSection, kind: 'closing', title: SECTION_TITLE_CLOSING });
  return { sections, chapterSection, moduleFirstSection, examSection, finalExamSection, closingSection };
}

/** El mismo layout derivado de facts (el shell no conoce el plan). */
export function sectionLayoutFromFacts(facts: CourseFacts): SectionLayoutV3 {
  return sectionLayoutV3({
    modules: facts.modules.map((m) => ({
      id: m.id,
      number: m.number,
      examEnabled: m.examEnabled,
      chapters: m.chapterNumbers.map((n) => {
        const ch = facts.chapters.find((c) => c.number === n);
        if (!ch) throw new Error(`SECTION_LAYOUT_INVALID: capítulo ${n} ausente en facts`);
        return { id: ch.id, number: ch.number, title: ch.title };
      }),
    })),
    finalExam: facts.finalExam.enabled,
  });
}

/** Paso siguiente al terminar un capítulo (botón del cierre del capítulo). */
export type ChapterNextStep =
  | { kind: 'chapter'; number: number; title: string; sectionNum: number }
  | { kind: 'module_exam'; moduleNumber: number; sectionNum: number }
  | { kind: 'module'; number: number; title: string; sectionNum: number }
  | { kind: 'final_exam'; sectionNum: number }
  | { kind: 'closing'; sectionNum: number };

/** chapterId → paso siguiente, según el layout (una sola fuente de verdad). */
export function chapterNextSteps(facts: CourseFacts, layout: SectionLayoutV3 = sectionLayoutFromFacts(facts)): Record<string, ChapterNextStep> {
  const out: Record<string, ChapterNextStep> = {};
  facts.modules.forEach((m, mi) => {
    m.chapterNumbers.forEach((n, ci) => {
      const ch = facts.chapters.find((c) => c.number === n);
      if (!ch) throw new Error(`SECTION_LAYOUT_INVALID: capítulo ${n} ausente en facts`);
      const nextN = m.chapterNumbers[ci + 1];
      if (nextN !== undefined) {
        const nx = facts.chapters.find((c) => c.number === nextN);
        if (!nx) throw new Error(`SECTION_LAYOUT_INVALID: capítulo ${nextN} ausente en facts`);
        out[ch.id] = { kind: 'chapter', number: nx.number, title: nx.title, sectionNum: layout.chapterSection[nx.id] };
        return;
      }
      if (m.examEnabled) {
        out[ch.id] = { kind: 'module_exam', moduleNumber: m.number, sectionNum: layout.examSection[m.id] };
        return;
      }
      const nm = facts.modules[mi + 1];
      if (nm) out[ch.id] = { kind: 'module', number: nm.number, title: nm.title, sectionNum: layout.moduleFirstSection[nm.id] };
      else if (layout.finalExamSection !== null) out[ch.id] = { kind: 'final_exam', sectionNum: layout.finalExamSection };
      else out[ch.id] = { kind: 'closing', sectionNum: layout.closingSection };
    });
  });
  for (const [id, s] of Object.entries(out)) {
    if (!Number.isInteger(s.sectionNum)) throw new Error(`SECTION_LAYOUT_INVALID: el capítulo ${id} no tiene sección de destino`);
  }
  return out;
}
