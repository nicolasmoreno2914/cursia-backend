/**
 * r107 B2 · adaptador `v2-dynamic` — paquetes del builder dinámico (V2: `dynamic-mbz-builder.ts`, v1/v2, y
 * `dynamic-mbz-builder-v3.ts`, 3.x). Se reconoce por h5pactivity / book (familyOf).
 *
 * Reglas, en orden (la primera que responde gana):
 *   1. CLAVE del builder en module.xml `<idnumber>`: `cvN:ch:<uuid capítulo>:<parte>` → rol por `DYNAMIC_CHAPTER_KEYS`
 *      (presentation → presentation; opening / deepening / video_primer / synthesis / closing → text;
 *      activity_instruction / application_instruction / self_check → cta; video → video; activity / review_cards → game;
 *      guided_practice / application / application_solution / resource:<x> → activity). `cvN:shell:<k>`,
 *      `cvN:module_intro|module_next|exam_info|exam|exam_explanations:<uuid módulo>`, `cvN:final_exam*` → clase del curso.
 *      Número de capítulo: del título («Capítulo N · …», «… · Capítulo N: …», «… del capítulo N»); si el título no lo
 *      dice, el de su sección («Módulo M · Capítulo N: …»). El uuid del capítulo se guarda (fuente de la base, B2 §3).
 *   2. TÍTULO (actividades sin clave: builders previos o editadas): ver `classifyByDynamicTitle`.
 *   3. Nada → `unknown` con el motivo.
 * Módulo del capítulo: de su sección («Módulo M · Capítulo N» en v3; «Módulo M — <nombre>» en v1/v2, donde varios
 * capítulos comparten sección). Título del capítulo: nombre de la sección (v3) o «… · Capítulo N: <título>».
 * Roles esperados en todo capítulo: algún texto (apertura / profundización / síntesis / cierre) y algo para practicar
 * (juego H5P/SCORM o actividad). La presentación y el video dependen del plan (videoEnabled / capítulo de práctica).
 */
import { FamilyAdapter } from '../course-model';
import { classifyByDynamicKey, classifyByDynamicTitle, noRule, sectionInfoOf } from './common';

export const v2DynamicAdapter: FamilyAdapter = {
  family: 'v2-dynamic',
  expectedChapterRoles: [['text'], ['game', 'activity']],
  section: sectionInfoOf,
  classify: (i) => classifyByDynamicKey(i) ?? classifyByDynamicTitle(i) ?? noRule(i, 'v2-dynamic'),
};
