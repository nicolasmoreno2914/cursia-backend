// Cursia V2.1 / R7-core — textos de interfaz en español latinoamericano (es-419)
// para las 7 librerías de CURSIA_H5P_PROFILE_V1.
//
// Las claves son rutas punteadas de `semantics.json` de cada librería: todos los
// campos de texto con `default` en inglés (grupos l10n, texts, UI, a11y,
// endGame, confirmCheck/confirmRetry…). Punto de partida: `language/es-mx.json`
// de cada librería, revisado (tuteo, "Ver solución", "Retroalimentación",
// "Puntaje"; sin "Letreritos", sin "PantallaCompleta").
//
// Los campos que son CONTENIDO (no interfaz) no están aquí porque los llena el
// builder desde la entrada: DragText.taskDescription, Blanks.text,
// InteractiveVideo…startScreenOptions.title.
//
// scripts/check-v21-h5p.js recorre semantics.json y falla si algún campo con
// default en inglés queda sin valor en español en la salida de los builders,
// o si una traducción pierde un placeholder (@score, :num, %d…).

const CONFIRM_DIALOGS: Record<string, string> = {
  'confirmCheck.header': '¿Finalizar?',
  'confirmCheck.body': '¿Seguro que quieres finalizar?',
  'confirmCheck.cancelLabel': 'Cancelar',
  'confirmCheck.confirmLabel': 'Finalizar',
  'confirmRetry.header': '¿Reintentar?',
  'confirmRetry.body': '¿Seguro que quieres volver a intentarlo?',
  'confirmRetry.cancelLabel': 'Cancelar',
  'confirmRetry.confirmLabel': 'Confirmar',
};

const SCORE_BAR = 'Obtuviste :num de :total puntos';
const A11Y_CHECK = 'Comprobar las respuestas. Se marcarán como correctas, incorrectas o sin responder.';
const A11Y_SHOW_SOLUTION = 'Ver la solución. La tarea se marcará con su solución correcta.';
const A11Y_RETRY = 'Reintentar la tarea. Se borrarán todas las respuestas y empezarás de nuevo.';

export const H5P_L10N_ES419: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'H5P.QuestionSet': Object.freeze({
    'introPage.startButtonText': 'Comenzar',
    'texts.prevButton': 'Pregunta anterior',
    'texts.nextButton': 'Pregunta siguiente',
    'texts.finishButton': 'Finalizar',
    'texts.submitButton': 'Enviar',
    'texts.textualProgress': 'Pregunta @current de @total',
    'texts.jumpToQuestion': 'Pregunta %d de %total',
    'texts.questionLabel': 'Pregunta',
    'texts.readSpeakerProgress': 'Pregunta @current de @total',
    'texts.unansweredText': 'Sin responder',
    'texts.answeredText': 'Respondida',
    'texts.currentQuestionText': 'Pregunta actual',
    'texts.navigationLabel': 'Preguntas',
    'texts.questionSetInstruction': 'Elige la pregunta que quieres ver',
    'endGame.noResultMessage': 'Terminado',
    'endGame.message': 'Tu resultado:',
    'endGame.scoreBarLabel': 'Obtuviste @finals de @totals puntos',
    'endGame.solutionButtonText': 'Ver solución',
    'endGame.retryButtonText': 'Reintentar',
    'endGame.finishButtonText': 'Finalizar',
    'endGame.submitButtonText': 'Enviar',
    'endGame.skipButtonText': 'Omitir video',
  }),
  'H5P.MultiChoice': Object.freeze({
    'UI.checkAnswerButton': 'Comprobar',
    'UI.submitAnswerButton': 'Enviar',
    'UI.showSolutionButton': 'Ver solución',
    'UI.tryAgainButton': 'Reintentar',
    'UI.tipsLabel': 'Ver pista',
    'UI.scoreBarLabel': SCORE_BAR,
    'UI.tipAvailable': 'Pista disponible',
    'UI.feedbackAvailable': 'Retroalimentación disponible',
    'UI.readFeedback': 'Leer retroalimentación',
    'UI.wrongAnswer': 'Respuesta incorrecta',
    'UI.correctAnswer': 'Respuesta correcta',
    'UI.shouldCheck': 'Debía estar seleccionada',
    'UI.shouldNotCheck': 'No debía estar seleccionada',
    'UI.noInput': 'Responde antes de ver la solución',
    'UI.a11yCheck': A11Y_CHECK,
    'UI.a11yShowSolution': A11Y_SHOW_SOLUTION,
    'UI.a11yRetry': A11Y_RETRY,
    ...CONFIRM_DIALOGS,
  }),
  'H5P.TrueFalse': Object.freeze({
    'l10n.trueText': 'Verdadero',
    'l10n.falseText': 'Falso',
    'l10n.score': 'Obtuviste @score de @total puntos',
    'l10n.checkAnswer': 'Comprobar',
    'l10n.submitAnswer': 'Enviar',
    'l10n.showSolutionButton': 'Ver solución',
    'l10n.tryAgain': 'Reintentar',
    'l10n.wrongAnswerMessage': 'Respuesta incorrecta',
    'l10n.correctAnswerMessage': 'Respuesta correcta',
    'l10n.scoreBarLabel': SCORE_BAR,
    'l10n.a11yCheck': A11Y_CHECK,
    'l10n.a11yShowSolution': A11Y_SHOW_SOLUTION,
    'l10n.a11yRetry': A11Y_RETRY,
    ...CONFIRM_DIALOGS,
  }),
  'H5P.SingleChoiceSet': Object.freeze({
    'l10n.nextButtonLabel': 'Siguiente pregunta',
    'l10n.nextButton': 'Siguiente',
    'l10n.showResultsButtonLabel': 'Ver resultados',
    'l10n.retryButtonLabel': 'Reintentar',
    'l10n.solutionViewTitle': 'Lista de soluciones',
    'l10n.correctText': '¡Correcto!',
    'l10n.incorrectText': '¡Incorrecto!',
    'l10n.shouldSelect': 'Debía estar seleccionada',
    'l10n.shouldNotSelect': 'No debía estar seleccionada',
    'l10n.muteButtonLabel': 'Silenciar el sonido de retroalimentación',
    'l10n.closeButtonLabel': 'Cerrar',
    'l10n.slideOfTotal': 'Pregunta :num de :total',
    'l10n.scoreBarLabel': SCORE_BAR,
    'l10n.solutionListQuestionNumber': 'Pregunta :num',
    'l10n.a11yShowSolution': A11Y_SHOW_SOLUTION,
    'l10n.a11yRetry': A11Y_RETRY,
    'l10n.resultHeader': 'Tu resultado:',
    'l10n.totalScore': ':score de :maxScore correctas',
    'l10n.resultTableHeader': 'Pregunta',
    'l10n.resultScoreTableHeader': 'Puntaje',
    'l10n.correctAnswerIntroduction': 'Respuesta correcta',
  }),
  'H5P.DragText': Object.freeze({
    checkAnswer: 'Comprobar',
    submitAnswer: 'Enviar',
    tryAgain: 'Reintentar',
    showSolution: 'Ver solución',
    dropZoneIndex: 'Zona de destino @index.',
    empty: 'La zona de destino @index está vacía.',
    contains: 'La zona de destino @index contiene el elemento @draggable.',
    ariaDraggableIndex: 'Elemento @index de @count.',
    tipLabel: 'Ver pista',
    correctText: '¡Correcto!',
    incorrectText: '¡Incorrecto!',
    resetDropTitle: 'Vaciar zona',
    resetDropDescription: '¿Seguro que quieres vaciar esta zona de destino?',
    grabbed: 'Elemento tomado.',
    cancelledDragging: 'Arrastre cancelado.',
    correctAnswer: 'Respuesta correcta:',
    feedbackHeader: 'Retroalimentación',
    scoreBarLabel: SCORE_BAR,
    a11yCheck: A11Y_CHECK,
    a11yShowSolution: A11Y_SHOW_SOLUTION,
    a11yRetry: A11Y_RETRY,
  }),
  'H5P.Blanks': Object.freeze({
    showSolutions: 'Ver solución',
    tryAgain: 'Reintentar',
    checkAnswer: 'Comprobar',
    submitAnswer: 'Enviar',
    notFilledOut: 'Completa todos los espacios para ver la solución',
    // Comillas tipográficas: el validador H5P convierte ' en &#039;.
    answerIsCorrect: '“:ans” es correcto',
    answerIsWrong: '“:ans” es incorrecto',
    answeredCorrectly: 'Respondido correctamente',
    answeredIncorrectly: 'Respondido incorrectamente',
    solutionLabel: 'Respuesta correcta:',
    inputLabel: 'Espacio @num de @total',
    inputHasTipLabel: 'Pista disponible',
    tipLabel: 'Pista',
    ...CONFIRM_DIALOGS,
    scoreBarLabel: SCORE_BAR,
    a11yCheck: A11Y_CHECK,
    a11yShowSolution: A11Y_SHOW_SOLUTION,
    a11yRetry: A11Y_RETRY,
    a11yCheckingModeHeader: 'Modo de revisión',
  }),
  'H5P.InteractiveVideo': Object.freeze({
    'l10n.interaction': 'Interacción',
    'l10n.play': 'Reproducir',
    'l10n.pause': 'Pausar',
    'l10n.mute': 'Silenciar, sonido activado',
    'l10n.unmute': 'Activar sonido, actualmente silenciado',
    'l10n.quality': 'Calidad del video',
    'l10n.captions': 'Subtítulos',
    'l10n.close': 'Cerrar',
    'l10n.fullscreen': 'Pantalla completa',
    'l10n.exitFullscreen': 'Salir de pantalla completa',
    'l10n.summary': 'Abrir resumen',
    'l10n.bookmarks': 'Marcadores',
    'l10n.endscreen': 'Pantalla de envío',
    'l10n.defaultAdaptivitySeekLabel': 'Continuar',
    'l10n.continueWithVideo': 'Continuar con el video',
    'l10n.more': 'Más opciones del reproductor',
    'l10n.playbackRate': 'Velocidad de reproducción',
    'l10n.rewind10': 'Retroceder 10 segundos',
    'l10n.navDisabled': 'La navegación está deshabilitada',
    'l10n.navForwardDisabled': 'No se puede adelantar el video',
    'l10n.sndDisabled': 'El sonido está deshabilitado',
    'l10n.requiresCompletionWarning': 'Debes responder correctamente todas las preguntas antes de continuar.',
    'l10n.back': 'Atrás',
    'l10n.hours': 'Horas',
    'l10n.minutes': 'Minutos',
    'l10n.seconds': 'Segundos',
    'l10n.currentTime': 'Tiempo actual:',
    'l10n.totalTime': 'Tiempo total:',
    'l10n.singleInteractionAnnouncement': 'Apareció una interacción:',
    'l10n.multipleInteractionsAnnouncement': 'Aparecieron varias interacciones.',
    'l10n.videoPausedAnnouncement': 'Video en pausa',
    'l10n.content': 'Contenido',
    'l10n.answered': '@answered respondidas',
    'l10n.endcardTitle': '@answered pregunta(s) respondida(s)',
    'l10n.endcardInformation': 'Respondiste @answered preguntas. Haz clic abajo para enviar tus respuestas.',
    'l10n.endcardInformationOnSubmitButtonDisabled': 'Respondiste @answered preguntas.',
    'l10n.endcardInformationNoAnswers': 'No has respondido ninguna pregunta.',
    'l10n.endcardInformationMustHaveAnswer': 'Debes responder al menos una pregunta antes de enviar tus respuestas.',
    'l10n.endcardSubmitButton': 'Enviar respuestas',
    'l10n.endcardSubmitMessage': '¡Tus respuestas fueron enviadas!',
    'l10n.endcardTableRowAnswered': 'Preguntas respondidas',
    'l10n.endcardTableRowScore': 'Puntaje',
    'l10n.endcardAnsweredScore': 'respondida',
    'l10n.endCardTableRowSummaryWithScore':
      'Obtuviste @score de @total puntos en la @question que apareció a los @minutes minutos y @seconds segundos.',
    'l10n.endCardTableRowSummaryWithoutScore':
      'Respondiste la @question que apareció a los @minutes minutos y @seconds segundos.',
    'l10n.videoProgressBar': 'Progreso del video',
    'l10n.howToCreateInteractions': 'Reproduce el video para empezar a crear interacciones',
  }),
});

/**
 * Tokens que son idénticos en inglés y español (o no son texto de interfaz) y
 * por eso pueden quedar con su default. Solo tokens, nunca frases.
 */
export const H5P_L10N_IDENTICAL_ALLOWLIST: ReadonlyArray<string> = Object.freeze(['rgb(255, 255, 255)']);

function setPath(target: Record<string, any>, dotted: string, value: string): void {
  const parts = dotted.split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === undefined) cur[p] = {};
    if (typeof cur[p] !== 'object' || cur[p] === null || Array.isArray(cur[p])) {
      throw new Error(`H5P_L10N_PATH_CONFLICT: ${dotted}`);
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Escribe todos los textos es-419 de `machineName` sobre `params` (muta y
 * devuelve `params`). Falla fuerte si la librería no tiene tabla.
 */
export function applyH5pL10n<T extends Record<string, any>>(machineName: string, params: T): T {
  const table = H5P_L10N_ES419[machineName];
  if (!table) throw new Error(`H5P_L10N_MISSING_LIBRARY: ${machineName}`);
  for (const key of Object.keys(table).sort()) setPath(params, key, table[key]);
  return params;
}
