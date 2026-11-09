/**
 * r107 B2 · adaptador `moodle-reexport` — un curso de Cursia restaurado en Moodle y vuelto a exportar por Moodle
 * (tar.gz, nombre `copia_de_seguridad-moodle2-…` / `backup-moodle2-…`, o users.xml con usuarios). Moodle renumera
 * moduleids / contextos / secciones, puede traer usuarios, logs y librerías H5P, y reescribe el nombre de los labels
 * (comienzo del texto o «labelNNN»). Se usa lo que Moodle deja:
 *
 *   1. Títulos de actividades que no son label (los conserva Moodle o los editó el docente): `classifyByReexportTitle`
 *      (hvp «Capítulo N: T» → video; scorm «Actividad Interactiva Capítulo N» → game; quiz «Examen [Final] Unidad N» →
 *      exam; «Examen Final…» → final_exam; resource «Libro Guia» → libro; page «Audio de Bienvenida» / «Audiolibro»).
 *   2. Títulos V1 intactos (re-export de un curso sin editar): `classifyByV1Title`.
 *   3. CONTENIDO del label (plantillas de 09-mbz.js): `classifyByContent`.
 *   4. Nada → `unknown` con el motivo (p. ej. labels que el docente escribió a mano en Moodle).
 * Unidades: secciones «Unidad N» / «Módulo N — …». Ningún capítulo se deduce por posición si nada lo nombra.
 * Roles esperados: algún texto o video, y el juego.
 */
import { FamilyAdapter } from '../course-model';
import { classifyByContent, classifyByReexportTitle, classifyByV1Title, noRule, sectionInfoOf } from './common';

export const moodleReexportAdapter: FamilyAdapter = {
  family: 'moodle-reexport',
  expectedChapterRoles: [['text', 'video'], ['game']],
  section: sectionInfoOf,
  classify: (i) => classifyByReexportTitle(i) ?? classifyByV1Title(i) ?? classifyByContent(i) ?? noRule(i, 'moodle-reexport'),
};
