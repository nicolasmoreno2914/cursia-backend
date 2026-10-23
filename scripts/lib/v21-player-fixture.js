/* eslint-disable */
// Cursia V2.1 — fixtures (texto plano, simulan la salida del LLM) para la prueba
// con reproductor REAL de QuestionSet, SingleChoiceSet, DragText y Blanks
// (review G4 I4). Cada fixture declara qué responder para una nota PARCIAL.
'use strict';

const QS = {
  itemKey: 'activity:ch1',
  title: 'Comprueba tu comprensión: matriz de peligros',
  passPercentage: 70,
  questions: [
    { kind: 'multichoice', question: '¿Cómo se calcula el nivel de riesgo?', answers: [{ text: 'Probabilidad por severidad', correct: true }, { text: 'Probabilidad más exposición', correct: false }, { text: 'Solo la severidad', correct: false }] },
    { kind: 'truefalse', question: 'La matriz sirve para priorizar qué riesgos atender primero.', correct: true },
    { kind: 'multichoice', question: '¿Qué se hace primero al valorar un riesgo?', answers: [{ text: 'Identificar el peligro', correct: true }, { text: 'Comprar equipos', correct: false }, { text: 'Sancionar al trabajador', correct: false }] },
    { kind: 'truefalse', question: 'Si la severidad es leve, el riesgo nunca requiere controles.', correct: false },
  ],
};
// Respuestas elegidas (texto visible): 3 de 4 correctas ⇒ 75, COMPLETE_PASS.
const QS_PICKS = ['Probabilidad por severidad', 'Verdadero', 'Comprar equipos', 'Falso'];

const SCS = {
  itemKey: 'activity:ch2',
  title: 'Práctica rápida: valoración de riesgos',
  passPercentage: 70,
  questions: [
    { question: '¿Qué escala de probabilidad usa la matriz?', answers: [{ text: 'Baja, media y alta', correct: true }, { text: 'Uno a cien', correct: false }, { text: 'Leve y grave', correct: false }] },
    { question: '¿Qué control es prioritario?', answers: [{ text: 'Eliminar el peligro', correct: true }, { text: 'Usar guantes', correct: false }, { text: 'Señalizar el área', correct: false }] },
    { question: '¿Cuándo se revisa la valoración?', answers: [{ text: 'Cuando cambian las condiciones', correct: true }, { text: 'Nunca', correct: false }, { text: 'Solo en auditorías', correct: false }] },
    { question: '¿Qué combina el nivel de riesgo?', answers: [{ text: 'Probabilidad y severidad', correct: true }, { text: 'Costo y tiempo', correct: false }, { text: 'Turno y área', correct: false }] },
  ],
};
// 1 de 4 correctas ⇒ 25, COMPLETE_FAIL (con el bug C1 salía 100/PASS).
const SCS_PICKS = ['Baja, media y alta', 'Usar guantes', 'Nunca', 'Costo y tiempo'];

const DT = {
  itemKey: 'activity:ch3',
  title: 'Completa la matriz',
  taskDescription: 'Arrastra cada palabra al lugar correcto.',
  text: 'El nivel de riesgo combina la *probabilidad* y la *severidad*.\nPrimero se *identifica* el peligro y luego se *controla*.',
};
// Palabra arrastrada a cada hueco (3.º y 4.º intercambiados) ⇒ 2 de 4 ⇒ 50, COMPLETE_FAIL.
const DT_DROPS = ['probabilidad', 'severidad', 'controla', 'identifica'];

const BL = {
  itemKey: 'activity:ch4',
  title: 'Completa las frases',
  text: 'Escribe la palabra que falta.',
  questions: ['El nivel de riesgo combina *probabilidad* y *severidad*.', 'La escala de probabilidad es baja, media y *alta*.', 'Primero se *identifica* el peligro.'],
};
// 3 de 4 correctas ⇒ 75, COMPLETE_PASS.
const BL_TYPED = ['probabilidad', 'severidad', 'baja', 'identifica'];

module.exports = { QS, QS_PICKS, SCS, SCS_PICKS, DT, DT_DROPS, BL, BL_TYPED };
