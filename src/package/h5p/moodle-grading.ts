// Cursia V2.1 — ¿califica Moodle (mod_h5pactivity core) cada librería principal del perfil?
//
// Evidencia con REPRODUCTOR REAL en Moodle 4.5 (scripts/check-v21-h5p-player.js,
// check-v21-video-moodle.js; review G4 I4):
// - IV, QuestionSet, DragText y Blanks: 1 intento, nota scaled×100, completion por
//   nota aprobatoria.
// - SingleChoiceSet 1.11: NO califica. Su getXAPIData() (que Moodle envía al
//   terminar, h5p/js/h5p_overrides.js) emite el statement padre con verbo
//   'answered' y un result SIN `completion`; mod_h5pactivity guarda el intento con
//   completion NULL y el grader solo usa intentos con completion = 1
//   (local/manager.php get_users_scaled_score) ⇒ nota vacía, completion
//   INCOMPLETE para siempre. No se puede corregir desde el contenido.
//
// Regla: una actividad CALIFICABLE solo puede usar librerías con gradable=true.
// assertH5pGradableInMoodle falla fuerte (nunca se empaqueta un SCS "calificable"
// que en la práctica no califica).
export interface H5pMoodleGradingInfo {
  gradable: boolean;
  evidence: string;
}

export const H5P_MOODLE_GRADING: Readonly<Record<string, Readonly<H5pMoodleGradingInfo>>> = Object.freeze({
  'H5P.InteractiveVideo': Object.freeze({ gradable: true, evidence: 'reproductor real: 1 intento, 80/40, COMPLETE_PASS/FAIL' }),
  'H5P.QuestionSet': Object.freeze({ gradable: true, evidence: 'reproductor real: 1 intento, 75, COMPLETE_PASS' }),
  'H5P.DragText': Object.freeze({ gradable: true, evidence: 'reproductor real: 1 intento, 50, COMPLETE_FAIL' }),
  'H5P.Blanks': Object.freeze({ gradable: true, evidence: 'reproductor real: 1 intento, 75, COMPLETE_PASS' }),
  'H5P.SingleChoiceSet': Object.freeze({
    gradable: false,
    evidence:
      "SCS 1.11 getXAPIData(): statement padre 'answered' sin result.completion ⇒ intento con completion NULL ⇒ mod_h5pactivity nunca califica (reproductor real: nota vacía, INCOMPLETE)",
  }),
  // Solo se usan como sub-contenido de IV/QS (nunca como actividad suelta en la primera ola).
  'H5P.MultiChoice': Object.freeze({ gradable: true, evidence: 'como sub-contenido de IV/QS' }),
  'H5P.TrueFalse': Object.freeze({ gradable: true, evidence: 'como sub-contenido de IV/QS' }),
});

/** Lanza H5P_NOT_GRADABLE_IN_MOODLE si la librería no califica en mod_h5pactivity (o es desconocida). */
export function assertH5pGradableInMoodle(mainLibrary: string): void {
  const info = H5P_MOODLE_GRADING[mainLibrary];
  if (!info) throw new Error(`H5P_NOT_GRADABLE_IN_MOODLE: ${mainLibrary} no está en H5P_MOODLE_GRADING`);
  if (!info.gradable) throw new Error(`H5P_NOT_GRADABLE_IN_MOODLE: ${mainLibrary} — ${info.evidence}`);
}
