/**
 * r107 B2 · adaptador `v1-legacy` — paquetes del builder V1 sin video H5P (`09-mbz.js` `exportMBZ` y su gemelo del
 * backend `mbz-builder.service.ts`): label + scorm + quiz, sin hvp.
 *
 * Estructura que arma el builder: sección 0 «Bienvenida e Introducción» (foro, bienvenida, audio, qué aprenderás,
 * metodología), sección 1 «Ruta de Aprendizaje y Libro Guía» (ruta, libro, audiolibro, resource «📚 Libro Guía
 * Completo»), secciones 2–4 «Módulo N — <nombre>» con 3 capítulos cada una y el examen de la unidad, sección 5 «Cierre y
 * Examen Final». Por capítulo: [📊 Presentación Cap N] → ▶️ Cap. N — Video: T (label con la página del capítulo) →
 * [🎮 Cap. N — Actividad Gamificada] → 🎮 Actividad Interactiva Cap N (scorm).
 *
 * Reglas (por TÍTULO, `classifyByV1Title`): las de arriba; «⚠️ Pendiente: <archivo>» → el rol de ese archivo con
 * `pending`; nombres de respaldo de friendlyName → por el archivo. Lo que no matchea → `unknown` con el motivo.
 * Ojo: «▶️ Cap. N — Video» es un LABEL con la página del capítulo (rol text), no un video interactivo.
 * Roles esperados en todo capítulo: texto (página del capítulo) y juego (scorm o su placeholder pendiente).
 */
import { FamilyAdapter } from '../course-model';
import { classifyByV1Title, noRule, sectionInfoOf } from './common';

export const v1LegacyAdapter: FamilyAdapter = {
  family: 'v1-legacy',
  expectedChapterRoles: [['text'], ['game']],
  section: sectionInfoOf,
  classify: (i) => classifyByV1Title(i) ?? noRule(i, 'v1-legacy'),
};
