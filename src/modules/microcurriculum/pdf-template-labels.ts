import { INSTITUTION_TYPES, TERMINOLOGY } from './microcurriculum.types';

/**
 * r86 · Rótulos FIJOS de la plantilla del PDF de microcurrículo (microcurriculum-pdf.ts), para reconocer un PDF de
 * Cursia ya descargado (sin la copia adjunta) y no tomar sus títulos y encabezados de tabla por contenido. Copiados
 * literalmente del renderizador; scripts/check-r86-cursia-pdf-import.js comprueba que cada uno aparece en un PDF real
 * (si el PDF cambia un rótulo, la prueba avisa).
 */

const uniq = (xs: string[]) => [...new Set(xs)];
const LEARNERS = uniq(INSTITUTION_TYPES.map((t) => TERMINOLOGY[t].learner));
const OUTCOME_LABELS = uniq(INSTITUTION_TYPES.map((t) => TERMINOLOGY[t].outcomesLabel));

export interface McTemplateLabels {
  /** Títulos de sección numerados («5 — Resultados de aprendizaje» en la lectura del PDF). */
  sections: string[];
  /** Encabezados de columna de las tablas. */
  columns: string[];
  /** Rótulos de las filas «rótulo | valor» (identificación y unidades). */
  rows: string[];
  /** Subtítulos dentro de las secciones. */
  subheadings: string[];
  /** Línea de la portada que firma la plantilla. */
  signature: string;
  /** Otras líneas fijas (portada, notas). */
  fixed: string[];
}

export function microcurriculumTemplateLabels(): McTemplateLabels {
  return {
    sections: uniq([
      'Identificación', 'Descripción y justificación', ...LEARNERS.map((l) => `Perfil del ${l} y prerrequisitos`), 'Objetivos', ...OUTCOME_LABELS,
      'Competencias', 'Unidades temáticas', 'Distribución de horas', 'Metodología', 'Evaluación', 'Recursos', 'Bibliografía',
    ]),
    columns: uniq(['Id', ...OUTCOME_LABELS, 'Verbo · Bloom', 'Criterio', 'Competencia', 'Unidad', 'Docente', 'Práctica', 'Autónomo', 'Total', 'Momento', '%', 'Semana', 'Evidencia']),
    rows: uniq([
      'Nombre del curso', 'Tipo de institución', 'Programa', 'Semestre / grado', 'Modalidad', 'Código', 'Área', 'Intensidad horaria', 'Docente',
      'Contenidos', ...OUTCOME_LABELS, 'Horas (D / P / A)', 'Semanas', 'Estrategia', 'Actividad principal',
    ]),
    subheadings: uniq(['Descripción', 'Justificación', ...LEARNERS.map((l) => `Perfil del ${l}`), 'Conocimientos previos', 'Objetivo general', 'Objetivos específicos', 'Estrategias didácticas']),
    signature: 'Preparado con Cursia · Microcurrículo',
    fixed: ['MICROCURRÍCULO', 'DOCENTE', 'FECHA', 'INTENSIDAD', 'CÓDIGO', 'D: trabajo con el docente · P: práctica · A: trabajo autónomo.', 'Sugerida por Cursia: verificar disponibilidad.', 'Revisar: quedan comprobaciones sin resolver',
      'Sin recursos adicionales.', 'Sin bibliografía registrada.'],
  };
}
