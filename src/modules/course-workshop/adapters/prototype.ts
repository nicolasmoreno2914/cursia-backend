/**
 * r107 B2 · adaptador `prototype` — paquetes de Cursia con estructura PARCIAL (sin scorm, sin quiz o sin labels:
 * builders tempranos, exportaciones de prueba, cursos con juegos «⚠️ Pendiente»). Se inventaría lo que haya, sin
 * inventar capítulos: un capítulo existe solo si alguna actividad lo nombra.
 *
 * Reglas, en orden: clave del builder dinámico (`classifyByDynamicKey`), títulos V1 (`classifyByV1Title`, incluidos
 * los «⚠️ Pendiente: <archivo>»), títulos del builder dinámico (`classifyByDynamicTitle`); nada →
 * `unknown` con el motivo. Sin roles esperados por capítulo (la estructura es parcial por definición): lo que falte se
 * ve en los roles de cada capítulo, no se marca como error del inventario.
 */
import { FamilyAdapter } from '../course-model';
import { classifyByDynamicKey, classifyByDynamicTitle, classifyByV1Title, noRule, sectionInfoOf } from './common';

export const prototypeAdapter: FamilyAdapter = {
  family: 'prototype',
  expectedChapterRoles: [],
  section: sectionInfoOf,
  classify: (i) => classifyByDynamicKey(i) ?? classifyByV1Title(i) ?? classifyByDynamicTitle(i) ?? noRule(i, 'prototype'),
};
