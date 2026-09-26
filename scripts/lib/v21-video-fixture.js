/* eslint-disable */
// Cursia V2.1 / R8 — fixture de `video_interactions` (simula la salida del LLM;
// sin LLM real). Alterna MultiChoice / TrueFalse. La prueba de navegador elige
// la respuesta por TEXTO (BANK[i].correct / .wrong), así funciona aunque H5P
// mezcle el orden de las opciones (randomAnswers).
'use strict';

const BANK = [
  { kind: 'multichoice', question: '¿Cómo se calcula el nivel de riesgo en la matriz de peligros?', correct: 'Probabilidad por severidad', wrong: ['Probabilidad más exposición', 'Solo la severidad', 'Cantidad de trabajadores'] },
  { kind: 'truefalse', question: 'Un peligro con probabilidad alta y severidad muy grave queda en nivel de riesgo alto.', correct: true },
  { kind: 'multichoice', question: '¿Qué escala de probabilidad usa la matriz del video?', correct: 'Baja, media y alta', wrong: ['Uno a cien', 'Leve y grave'] },
  { kind: 'truefalse', question: 'Si la severidad es leve, el riesgo nunca requiere controles.', correct: false },
  { kind: 'multichoice', question: '¿Qué se hace primero al valorar un riesgo?', correct: 'Identificar el peligro', wrong: ['Comprar equipos de protección', 'Sancionar al trabajador'] },
  { kind: 'truefalse', question: 'La valoración de riesgos se revisa cuando cambian las condiciones de trabajo.', correct: true },
  { kind: 'multichoice', question: '¿Qué control es prioritario según la jerarquía de controles?', correct: 'Eliminar el peligro', wrong: ['Señalizar el área', 'Usar guantes', 'Capacitar una vez al año'] },
  { kind: 'truefalse', question: 'La matriz de peligros sirve para priorizar qué riesgos atender primero.', correct: true },
];

/** Documento válido para `planInteractionCheckpoints(durationSec)` (plan = lista de {index}). */
function makeInteractionsDoc(plan, { videoItemKey = 'video:ch1', durationSec } = {}) {
  return {
    schemaVersion: 1,
    videoItemKey,
    durationSec,
    checkpoints: plan.map((c, i) => {
      const b = BANK[i % BANK.length];
      if (b.kind === 'multichoice') {
        return {
          index: c.index,
          kind: 'multichoice',
          question: b.question,
          answers: [{ text: b.correct, correct: true }, ...b.wrong.map((t) => ({ text: t, correct: false }))],
          feedbackCorrect: '¡Correcto! Así se valora el riesgo.',
          feedbackIncorrect: 'No es correcto: revisa esta parte del video.',
        };
      }
      return {
        index: c.index,
        kind: 'truefalse',
        question: b.question,
        correct: b.correct,
        feedbackCorrect: '¡Correcto!',
        feedbackIncorrect: 'No es correcto: revisa esta parte del video.',
      };
    }),
  };
}

module.exports = { BANK, makeInteractionsDoc };
