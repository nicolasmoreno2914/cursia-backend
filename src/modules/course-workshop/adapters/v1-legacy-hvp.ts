/**
 * r107 B2 · adaptador `v1-legacy-hvp` — builder V1 con Video Engine H5P (`mbz-builder.service.ts` con `hvpData`, y el
 * parche local `16-mbz-patch.js`): label + scorm + quiz + hvp.
 *
 * Mismas secciones que v1-legacy. Por capítulo (CLAUDE.md «Estructura por capítulo»): [📊 Presentación Cap N] →
 * [📖 Capítulo N — T (texto / introducción del video)] → 🎥 Video Interactivo Cap N (hvp) → [🎯 Practicar — Cap N
 * (CTA)] → 🎮 Actividad Interactiva Cap N (scorm). Las variantes más viejas solo traen 🎬 hvp + scorm (sin label de
 * texto ni CTA): por eso lo esperado es video + juego.
 *
 * Reglas: las mismas por título que v1-legacy (`classifyByV1Title`).
 */
import { FamilyAdapter } from '../course-model';
import { classifyByV1Title, noRule, sectionInfoOf } from './common';

export const v1LegacyHvpAdapter: FamilyAdapter = {
  family: 'v1-legacy-hvp',
  expectedChapterRoles: [['video'], ['game']],
  section: sectionInfoOf,
  classify: (i) => classifyByV1Title(i) ?? noRule(i, 'v1-legacy-hvp'),
};
