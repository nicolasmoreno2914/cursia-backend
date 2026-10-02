/**
 * Cursia V2.1 — R12: XML de quiz (GIFT → banco de preguntas) y de SCORM para
 * el builder v3. Portados del builder dinámico v1/v2 (que NO cambia) con tres
 * diferencias deliberadas:
 *  - determinismo: sin `Math.random()` en los `stamp` (se derivan del item y
 *    del índice) e ids de un asignador global (nunca colisionan entre quizzes);
 *  - `maxmark` de las preguntas suma EXACTAMENTE 100 (= sumgrades, §K.1;
 *    review G3 M10);
 *  - evaluación del perfil (R6): intentos/método en el quiz
 *    (`quizAttemptsXmlFields`) y `whatgrade`/`maxattempt` en el SCORM
 *    (`scormAssessmentFields`, completion solo por nota aprobatoria).
 * Puro.
 */
import { createHash } from 'crypto';
import { GiftQuestion, esc, parseGIFT, safeActivityName, xmlEsc } from '../mbz-common';
import { applyXmlFields, quizAttemptsXmlFields, scormAssessmentFields } from '../assessment';
import type { GradeMethod } from '../../modules/course-profiles/course-profiles';
import { EXAM_QUESTION_TYPES, bankFloor } from '../../modules/course-shell/exam-bank';
import type { ExamBankQuestion, ExamBankV1, ExamQuestionType } from '../../modules/course-shell/exam-bank';

/** Asignador monotónico de ids por "tabla" del backup (determinístico por orden de uso). */
export class IdAllocator {
  private readonly next = new Map<string, number>();
  constructor(private readonly bases: Record<string, number>) {}
  take(kind: string): number {
    const base = this.bases[kind];
    if (base === undefined) throw new Error(`ID_ALLOCATOR: tipo desconocido ${kind}`);
    const n = this.next.get(kind) ?? base;
    this.next.set(kind, n + 1);
    return n;
  }
}

function sha1(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

/**
 * P2-B1 (EV6 Fase 2 — exámenes que certifican): política de revisión del
 * quiz. El estudiante nunca ve corrección, retroalimentación ni la respuesta
 * correcta tras un intento — solo su nota (y la nota máxima), durante el
 * intento y después (inmediatamente / más tarde mientras está abierto); todo
 * se revela solo si un profesor fija `timeclose` en el pasado (AFTER_CLOSE).
 * Bits de Moodle (`mod/quiz/classes/question/display_options.php`):
 * D(URING)=0x10000, I(MMEDIATELY_AFTER)=0x1000, O(PEN, "later while
 * open")=0x100, C(LOSE, "after close")=0x10. Probado en Moodle 4.5.14+
 * contra una restauración real — ver `scratchpad/r18/P2-design.md` §1.
 *
 * V542 (I4, builder 3.7.0): `reviewattempt` incluye I. Sin eso, Moodle redirige a review.php al
 * terminar el intento y lo devuelve a view.php con «No tiene permiso para revisar este cuestionario».
 *
 * V542 fix round 1 (I1, builder 3.9.0) — regla del usuario: las respuestas correctas se revelan SOLO en
 * «Respuestas explicadas» (al aprobar o agotar los intentos). La nota POR PREGUNTA junto a la respuesta
 * propia revela la correcta (V/F: «0 sobre 5,88» con «Verdadero» marcado = la correcta es «Falso»), así que:
 *  - D|I (durante e inmediatamente después, ~2 min): la página de revisión muestra las respuestas propias
 *    SIN nota por pregunta (marks = MAX_ONLY: «Puntúa como 5,88») ni corrección → sin el aviso de permiso;
 *  - O (más tarde, abierto): sin página de revisión; la nota TOTAL se ve en view.php y en el libro de
 *    calificaciones (marks O ⇒ quiz_grade_item_update deja el ítem visible) y la completion sigue igual;
 *  - C (cierre, solo si un profesor fija timeclose): todo.
 * QUIZFB (builder 3.10.0, re-verificación #542 R1): `reviewoverallfeedback` I|O|C — al terminar, la página de
 * revisión muestra la retroalimentación GLOBAL del quiz («aprobaste» desde la nota mínima del perfil / «todavía no»,
 * `feedbackBands`). Moodle 4.5 no tiene forma de mostrar la nota del intento sin las notas por pregunta (las dos
 * salen de «marks»), así que el resultado inmediato llega por ese mensaje; la nota queda en Calificaciones (ítem
 * visible) y en view.php más tarde (O). Corrección, feedback por pregunta y respuesta correcta siguen solo en C.
 * Compromiso (documentado): nunca hay notas por pregunta mientras el examen está abierto, y la revisión
 * del intento solo está disponible justo al terminarlo; la nota total aparece en view.php ~2 min después
 * (en el libro de calificaciones, de inmediato).
 */
export const QUIZ_REVIEW_V3 = {
  reviewattempt: 69648, // D|I|C — revisión de las respuestas propias al terminar (sin aviso de permiso)
  reviewcorrectness: 16, // C
  reviewmaxmarks: 69904, // D|I|O|C — «Puntúa como N» (sin la nota obtenida)
  reviewmarks: 272, // O|C — nota (total y por pregunta) solo cuando NO hay página de revisión abierta (O) o al cierre
  reviewspecificfeedback: 16, // C
  reviewgeneralfeedback: 16, // C
  reviewrightanswer: 16, // C
  reviewoverallfeedback: 4368, // I|O|C — QUIZFB: «aprobaste / todavía no» (retroalimentación global) al terminar
} as const satisfies Record<string, number>;

/** `maxmark` por pregunta con 7 decimales cuya suma es exactamente 100. */
export function quizMaxMarks(n: number): string[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`QUIZ_V3_INVALID: cantidad de preguntas ${n}`);
  const unit = 1e7; // 7 decimales
  const total = 100 * unit;
  const base = Math.floor(total / n);
  const rest = total - base * n;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = base + (i >= n - rest ? 1 : 0);
    out.push(`${Math.floor(v / unit)}.${String(v % unit).padStart(7, '0')}`);
  }
  return out;
}

export interface QuizV3Input {
  aid: number;
  mid: number;
  ctx: number;
  name: string;
  introHtml: string;
  /** GIFT (slots fijos, una `question_reference` por pregunta). Exactamente uno de `gift` | `bank`. */
  gift?: string;
  /** EV6 P2-B3: banco JSON → slots aleatorios por hoja (capítulo|módulo × tipo). */
  bank?: QuizV3Bank;
  attempts: number;
  grademethod: GradeMethod;
  ts: number;
  /** Semilla estable para los stamps (p.ej. el item_key). */
  stampSeed: string;
  ids: IdAllocator;
  /** QUIZFB: bandas de la retroalimentación global (quiz_feedback, escala 0–100). Sin ellas, `<feedbacks>` vacío. */
  feedbackBands?: ReadonlyArray<{ mingrade: number; maxgrade: number; html: string }>;
}

/**
 * EV6 P2-B3: banco del quiz. `groups` = categorías padre en orden del Manifest (examen de
 * módulo: un grupo por capítulo, `Capítulo N: título`; final: uno por módulo, `Módulo N:
 * título`); `ownerId` = chapterId | moduleId según `doc.scope`. Cada grupo tiene una hoja por
 * tipo con slots en `doc.plan` (orden multichoice, truefalse, match).
 */
export interface QuizV3Bank {
  doc: ExamBankV1;
  groups: Array<{ ownerId: string; name: string }>;
}

export interface QuizV3Output {
  quizXml: string;
  questionCategoriesXml: string;
  /** TODAS las categorías del quiz (inforef): top, por defecto y, en banco, padres y hojas. */
  categoryIds: number[];
  /** Slots del quiz (= preguntas que ve el estudiante por intento). */
  questionCount: number;
  /** Solo banco: preguntas del banco (todas las hojas). */
  bankSize?: number;
  /** EV6 P2-B5: solo banco — las hojas TAL COMO se escribieron (orden de categorías), expectativa de QUIZ_RANDOM. */
  leaves?: Array<{ category: string; type: ExamQuestionType; slots: number }>;
}

/** Nombre visible del tipo en la categoría hoja. */
export const EXAM_LEAF_TYPE_LABEL: Record<ExamQuestionType, string> = {
  multichoice: 'Selección múltiple',
  truefalse: 'Verdadero o falso',
  match: 'Emparejamiento',
};

export function buildQuizV3(p: QuizV3Input): QuizV3Output {
  if ((p.gift === undefined) === (p.bank === undefined)) throw new Error(`QUIZ_V3_INVALID: "${p.name}" necesita exactamente uno de gift | bank`);
  if (p.bank) return buildBankQuizV3(p, p.bank);
  const qs: GiftQuestion[] = parseGIFT(p.gift as string);
  if (qs.length === 0) throw new Error(`QUIZ_V3_EMPTY: el GIFT de "${p.name}" no produjo ninguna pregunta parseable (no se genera un quiz vacío)`);
  const marks = quizMaxMarks(qs.length);
  const catTop = p.ids.take('qcat');
  const catDefault = p.ids.take('qcat');
  const cat = p.ids.take('qcat');
  let instances = '';
  let entries = '';
  qs.forEach((q, qi) => {
    const qbe = p.ids.take('qbe');
    const qv = p.ids.take('qversion');
    const qid = p.ids.take('question');
    const slot = qi + 1;
    instances += `      <question_instance id="${p.ids.take('qinstance')}">
        <quizid>${p.aid}</quizid><slot>${slot}</slot><page>${Math.ceil(slot / 5)}</page>
        <displaynumber>$@NULL@$</displaynumber><requireprevious>0</requireprevious>
        <maxmark>${marks[qi]}</maxmark><quizgradeitemid>$@NULL@$</quizgradeitemid>
        <question_reference id="${p.ids.take('qref')}">
          <usingcontextid>${p.ctx}</usingcontextid><component>mod_quiz</component>
          <questionarea>slot</questionarea><questionbankentryid>${qbe}</questionbankentryid>
          <version>$@NULL@$</version>
        </question_reference>
      </question_instance>\n`;
    let plugin = '';
    if (q.type === 'multichoice') {
      const ans = q.options
        .map((o) => `<answer id="${p.ids.take('answer')}"><answertext>${xmlEsc(o.text)}</answertext><answerformat>0</answerformat><fraction>${o.correct ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer>`)
        .join('');
      plugin = `<plugin_qtype_multichoice_question><answers>${ans}</answers><multichoice id="${p.ids.take('qoptions')}"><layout>0</layout><single>1</single><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>0</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>0</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>0</incorrectfeedbackformat><answernumbering>abc</answernumbering><shownumcorrect>0</shownumcorrect><showstandardinstruction>0</showstandardinstruction></multichoice></plugin_qtype_multichoice_question>`;
    } else if (q.type === 'truefalse') {
      const t = p.ids.take('answer');
      const f = p.ids.take('answer');
      plugin = `<plugin_qtype_truefalse_question><answers><answer id="${t}"><answertext>Verdadero</answertext><answerformat>0</answerformat><fraction>${q.answer ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer><answer id="${f}"><answertext>Falso</answertext><answerformat>0</answerformat><fraction>${!q.answer ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer></answers><truefalse id="${p.ids.take('qoptions')}"><trueanswer>${t}</trueanswer><falseanswer>${f}</falseanswer><showstandardinstruction>0</showstandardinstruction></truefalse></plugin_qtype_truefalse_question>`;
    } else if (q.type === 'match') {
      const matches = q.pairs
        .map((pr) => `<match id="${p.ids.take('match')}"><questiontext>${xmlEsc(pr.q)}</questiontext><questiontextformat>0</questiontextformat><answertext>${xmlEsc(pr.a)}</answertext></match>`)
        .join('');
      plugin = `<plugin_qtype_match_question><matchoptions id="${p.ids.take('qoptions')}"><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>0</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>0</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>0</incorrectfeedbackformat><shownumcorrect>0</shownumcorrect></matchoptions><matches>${matches}</matches></plugin_qtype_match_question>`;
    } else {
      const ans = q.answers
        .map((a) => `<answer id="${p.ids.take('answer')}"><answertext>${xmlEsc(a)}</answertext><answerformat>0</answerformat><fraction>1.0000000</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer>`)
        .join('');
      plugin = `<plugin_qtype_shortanswer_question><answers>${ans}</answers><shortanswer id="${p.ids.take('qoptions')}"><usecase>0</usecase></shortanswer></plugin_qtype_shortanswer_question>`;
    }
    const stamp = `cursia.v3+${sha1(`${p.stampSeed}#q${qi}`).slice(0, 20)}`;
    entries += `      <question_bank_entry id="${qbe}">
        <questioncategoryid>${cat}</questioncategoryid><idnumber>$@NULL@$</idnumber><ownerid>2</ownerid>
        <question_version><question_versions id="${qv}"><version>1</version><status>ready</status>
        <questions><question id="${qid}">
          <parent>0</parent><name>${xmlEsc(q.name || `P${qi + 1}`)}</name>
          <questiontext>${xmlEsc(q.text)}</questiontext><questiontextformat>0</questiontextformat>
          <generalfeedback></generalfeedback><generalfeedbackformat>0</generalfeedbackformat>
          <defaultmark>1.0000000</defaultmark><penalty>0.3333333</penalty><qtype>${q.type}</qtype>
          <length>1</length><stamp>${stamp}</stamp>
          <timecreated>${p.ts}</timecreated><timemodified>${p.ts}</timemodified>
          <createdby>2</createdby><modifiedby>2</modifiedby>
          ${plugin}
          <plugin_qbank_comment_question><comments></comments></plugin_qbank_comment_question>
        </question></questions></question_versions></question_version>
      </question_bank_entry>\n`;
  });

  const quizXml = quizActivityXmlV3(p, instances);

  const questionCategoriesXml =
    catXml(p, catTop, 'top', 0, 0, '', '') +
    catXml(p, catDefault, `Por defecto en ${p.name}`, catTop, 999, `Categoría por defecto para preguntas compartidas en el contexto ${p.name}.`, '') +
    catXml(p, cat, p.name, catTop, 999, '', entries);
  return { quizXml, questionCategoriesXml, categoryIds: [catTop, catDefault, cat], questionCount: qs.length };
}

/** QUIZFB: `<feedback>` de cada banda (mingrade ≤ nota < maxgrade), en el orden dado. */
function feedbacksXml(p: QuizV3Input): string {
  const bands = p.feedbackBands ?? [];
  const dec = (n: number) => n.toFixed(5);
  for (const b of bands) {
    if (!(b.mingrade >= 0 && b.maxgrade > b.mingrade && b.maxgrade <= 101) || typeof b.html !== 'string' || !b.html.trim()) {
      throw new Error(`QUIZ_V3_INVALID: banda de retroalimentación ${JSON.stringify(b)}`);
    }
  }
  return bands
    .map((b) => `<feedback id="${p.ids.take('qfeedback')}"><feedbacktext>${xmlEsc(b.html)}</feedbacktext><feedbacktextformat>1</feedbacktextformat><mingrade>${dec(b.mingrade)}</mingrade><maxgrade>${dec(b.maxgrade)}</maxgrade></feedback>`)
    .join('');
}

/** `quiz.xml` (mismo template para GIFT y banco; `instances` = los `question_instance`). */
function quizActivityXmlV3(p: QuizV3Input, instances: string): string {
  const quizXmlBase = `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="quiz" contextid="${p.ctx}">
  <quiz id="${p.aid}">
    <name>${xmlEsc(p.name)}</name><intro>${xmlEsc(p.introHtml)}</intro><introformat>1</introformat>
    <timeopen>0</timeopen><timeclose>0</timeclose><timelimit>0</timelimit>
    <overduehandling>autosubmit</overduehandling><graceperiod>0</graceperiod>
    <preferredbehaviour>deferredfeedback</preferredbehaviour><canredoquestions>0</canredoquestions>
    <attempts_number>0</attempts_number><attemptonlast>0</attemptonlast>
    <grademethod>1</grademethod><decimalpoints>2</decimalpoints><questiondecimalpoints>-1</questiondecimalpoints>
    <reviewattempt>${QUIZ_REVIEW_V3.reviewattempt}</reviewattempt><reviewcorrectness>${QUIZ_REVIEW_V3.reviewcorrectness}</reviewcorrectness>
    <reviewmaxmarks>${QUIZ_REVIEW_V3.reviewmaxmarks}</reviewmaxmarks><reviewmarks>${QUIZ_REVIEW_V3.reviewmarks}</reviewmarks>
    <reviewspecificfeedback>${QUIZ_REVIEW_V3.reviewspecificfeedback}</reviewspecificfeedback><reviewgeneralfeedback>${QUIZ_REVIEW_V3.reviewgeneralfeedback}</reviewgeneralfeedback>
    <reviewrightanswer>${QUIZ_REVIEW_V3.reviewrightanswer}</reviewrightanswer><reviewoverallfeedback>${QUIZ_REVIEW_V3.reviewoverallfeedback}</reviewoverallfeedback>
    <questionsperpage>5</questionsperpage><navmethod>free</navmethod><shuffleanswers>1</shuffleanswers>
    <sumgrades>0.00000</sumgrades><grade>0.00000</grade>
    <timecreated>${p.ts}</timecreated><timemodified>${p.ts}</timemodified>
    <password></password><subnet></subnet><browsersecurity>-</browsersecurity>
    <delay1>0</delay1><delay2>0</delay2><showuserpicture>0</showuserpicture><showblocks>0</showblocks>
    <completionattemptsexhausted>0</completionattemptsexhausted><completionminattempts>0</completionminattempts>
    <allowofflineattempts>0</allowofflineattempts>
    <subplugin_quizaccess_seb_quiz></subplugin_quizaccess_seb_quiz>
    <quiz_grade_items></quiz_grade_items>
    <question_instances>\n${instances}    </question_instances>
    <sections><section id="${p.ids.take('qsection')}"><firstslot>1</firstslot><heading></heading><shufflequestions>0</shufflequestions></section></sections>
    <feedbacks>${feedbacksXml(p)}</feedbacks>
    <overrides></overrides><grades></grades><attempts></attempts>
  </quiz>
</activity>`;
  return applyXmlFields(quizXmlBase, quizAttemptsXmlFields({ attempts: p.attempts, grademethod: p.grademethod }));
}

/** Una `question_category` del contexto del quiz (contextlevel 70). */
function catXml(p: QuizV3Input, id: number, name: string, parent: number, sortorder: number, info: string, qbe: string): string {
  return `  <question_category id="${id}">
    <name>${xmlEsc(name)}</name>
    <contextid>${p.ctx}</contextid><contextlevel>70</contextlevel><contextinstanceid>${p.mid}</contextinstanceid>
    <info>${xmlEsc(info)}</info><infoformat>0</infoformat>
    <stamp>cursia.v3+cat+${sha1(`${p.stampSeed}#cat${id}`).slice(0, 20)}</stamp>
    <parent>${parent}</parent><sortorder>${sortorder}</sortorder><idnumber>$@NULL@$</idnumber>
    <question_bank_entries>${qbe ? `\n${qbe}    ` : ''}</question_bank_entries>
  </question_category>
`;
}

// ─── EV6 P2-B3: modo banco (slots aleatorios por hoja) ─────────────────────

/** `<p>texto</p>` con el texto plano escapado como HTML (FORMAT_HTML). */
function htmlPara(text: string): string {
  return `<p>${esc(text)}</p>`;
}

/** XML de los datos del qtype de una pregunta del banco (retroalimentación por opción, §2.2). */
function bankQuestionPluginXml(q: ExamBankQuestion, ids: IdAllocator): string {
  if (q.type === 'multichoice') {
    // La correcta primero; Moodle baraja las opciones (shuffleanswers 1) en cada intento.
    const opts = [{ ...q.correct, fraction: '1.0000000' }, ...q.distractors.map((d) => ({ ...d, fraction: '0.0000000' }))];
    const ans = opts
      .map((o) => `<answer id="${ids.take('answer')}"><answertext>${xmlEsc(o.text)}</answertext><answerformat>2</answerformat><fraction>${o.fraction}</fraction><feedback>${xmlEsc(htmlPara(o.why))}</feedback><feedbackformat>1</feedbackformat></answer>`)
      .join('');
    return `<plugin_qtype_multichoice_question><answers>${ans}</answers><multichoice id="${ids.take('qoptions')}"><layout>0</layout><single>1</single><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>1</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>1</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>1</incorrectfeedbackformat><answernumbering>abc</answernumbering><shownumcorrect>0</shownumcorrect><showstandardinstruction>0</showstandardinstruction></multichoice></plugin_qtype_multichoice_question>`;
  }
  if (q.type === 'truefalse') {
    // La respuesta equivocada lleva `whyWrong`; la correcta queda vacía (la explicación va en generalfeedback).
    const t = ids.take('answer');
    const f = ids.take('answer');
    const fbTrue = q.answer ? '' : xmlEsc(htmlPara(q.whyWrong));
    const fbFalse = q.answer ? xmlEsc(htmlPara(q.whyWrong)) : '';
    return `<plugin_qtype_truefalse_question><answers><answer id="${t}"><answertext>Verdadero</answertext><answerformat>0</answerformat><fraction>${q.answer ? '1.0000000' : '0.0000000'}</fraction><feedback>${fbTrue}</feedback><feedbackformat>1</feedbackformat></answer><answer id="${f}"><answertext>Falso</answertext><answerformat>0</answerformat><fraction>${!q.answer ? '1.0000000' : '0.0000000'}</fraction><feedback>${fbFalse}</feedback><feedbackformat>1</feedbackformat></answer></answers><truefalse id="${ids.take('qoptions')}"><trueanswer>${t}</trueanswer><falseanswer>${f}</falseanswer><showstandardinstruction>0</showstandardinstruction></truefalse></plugin_qtype_truefalse_question>`;
  }
  // match (fix 1, ruling del coordinador): la DEFINICIÓN es la subpregunta (FORMAT_PLAIN, texto largo
  // bien renderizado) y el TÉRMINO es la opción del desplegable (corta; `answertext` no tiene formato y
  // Moodle la pasa por format_string → el contrato prohíbe < > en `term`). Moodle arma las opciones con
  // los `answertext` distintos: los términos son únicos (EXAM_BANK_MATCH). El GIFT no cambia.
  // La explicación va en generalfeedback.
  const matches = q.pairs
    .map((pr) => `<match id="${ids.take('match')}"><questiontext>${xmlEsc(pr.definition)}</questiontext><questiontextformat>2</questiontextformat><answertext>${xmlEsc(pr.term)}</answertext></match>`)
    .join('');
  return `<plugin_qtype_match_question><matchoptions id="${ids.take('qoptions')}"><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>1</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>1</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>1</incorrectfeedbackformat><shownumcorrect>0</shownumcorrect></matchoptions><matches>${matches}</matches></plugin_qtype_match_question>`;
}

/**
 * Quiz con banco (P2-design §2.2): categorías top → «Por defecto en …» → padre por capítulo
 * (módulo en el final) → hojas por tipo con sus preguntas; un `question_instance` por slot con
 * `question_set_reference` a SU hoja (`includesubcategories` false, sin `cat`: lo agrega el
 * restore). `maxmark` suma exactamente 100 sobre los slots. Falla fuerte si el banco no cubre el
 * plan (hoja bajo el piso, pregunta o hoja sin grupo).
 */
function buildBankQuizV3(p: QuizV3Input, bank: QuizV3Bank): QuizV3Output {
  const doc = bank.doc;
  const fail = (msg: string): never => {
    throw new Error(`QUIZ_V3_BANK_INVALID: "${p.name}": ${msg}`);
  };
  if (!doc || !Array.isArray(doc.plan) || !Array.isArray(doc.questions)) fail('banco sin plan/preguntas');
  const leafOwner = (l: ExamBankV1['plan'][number]): string => ('chapterId' in l ? l.chapterId : l.moduleId);
  const qOwner = (q: ExamBankQuestion): string => (doc.scope === 'final' ? (q.moduleId as string) : q.chapterId);
  const slotsByLeaf = new Map<string, number>();
  for (const l of doc.plan) slotsByLeaf.set(`${leafOwner(l)}|${l.type}`, l.slots);
  const groupOwners = new Set(bank.groups.map((g) => g.ownerId));
  for (const l of doc.plan) if (!groupOwners.has(leafOwner(l))) fail(`la hoja ${leafOwner(l)}/${l.type} no tiene categoría padre`);

  const catTop = p.ids.take('qcat');
  const catDefault = p.ids.take('qcat');
  type Leaf = { id: number; name: string; type: ExamQuestionType; slots: number; questions: ExamBankQuestion[] };
  const groups: Array<{ id: number; name: string; leaves: Leaf[] }> = [];
  let placed = 0;
  for (const g of bank.groups) {
    const types = EXAM_QUESTION_TYPES.filter((t) => slotsByLeaf.has(`${g.ownerId}|${t}`));
    if (!types.length) continue;
    const parentName = safeActivityName(g.name, 255);
    const group = { id: p.ids.take('qcat'), name: parentName, leaves: [] as Leaf[] };
    for (const type of types) {
      const slots = slotsByLeaf.get(`${g.ownerId}|${type}`) as number;
      if (!Number.isInteger(slots) || slots < 1) fail(`slots inválidos en ${g.ownerId}/${type}`);
      const questions = doc.questions.filter((q) => q.type === type && qOwner(q) === g.ownerId);
      if (questions.length < bankFloor(slots)) fail(`la hoja ${g.ownerId}/${type} tiene ${questions.length} preguntas (mínimo ${bankFloor(slots)} para ${slots} slots)`);
      placed += questions.length;
      group.leaves.push({ id: p.ids.take('qcat'), name: safeActivityName(`${g.name} · ${EXAM_LEAF_TYPE_LABEL[type]}`, 255), type, slots, questions });
    }
    groups.push(group);
  }
  if (placed !== doc.questions.length) fail(`${doc.questions.length - placed} preguntas no pertenecen a ninguna hoja del plan`);
  const leaves = groups.flatMap((g) => g.leaves);
  const slotCount = leaves.reduce((a, l) => a + l.slots, 0);
  const marks = quizMaxMarks(slotCount);

  let instances = '';
  let slot = 0;
  for (const leaf of leaves) {
    const filter = JSON.stringify({ filter: { category: { jointype: 1, values: [leaf.id], filteroptions: { includesubcategories: false } } } });
    for (let k = 0; k < leaf.slots; k++) {
      slot++;
      instances += `      <question_instance id="${p.ids.take('qinstance')}">
        <quizid>${p.aid}</quizid><slot>${slot}</slot><page>${Math.ceil(slot / 5)}</page>
        <displaynumber>$@NULL@$</displaynumber><requireprevious>0</requireprevious>
        <maxmark>${marks[slot - 1]}</maxmark><quizgradeitemid>$@NULL@$</quizgradeitemid>
        <question_set_reference id="${p.ids.take('qsetref')}">
          <usingcontextid>${p.ctx}</usingcontextid><component>mod_quiz</component>
          <questionarea>slot</questionarea><questionscontextid>${p.ctx}</questionscontextid>
          <filtercondition>${filter}</filtercondition>
        </question_set_reference>
      </question_instance>\n`;
    }
  }

  const entriesOf = (leaf: Leaf): string =>
    leaf.questions
      .map((q) => {
        const qbe = p.ids.take('qbe');
        const qv = p.ids.take('qversion');
        const qid = p.ids.take('question');
        const plugin = bankQuestionPluginXml(q, p.ids);
        const stamp = `cursia.v3+${sha1(`${p.stampSeed}#bank#${q.id}`).slice(0, 20)}`;
        return `      <question_bank_entry id="${qbe}">
        <questioncategoryid>${leaf.id}</questioncategoryid><idnumber>$@NULL@$</idnumber><ownerid>2</ownerid>
        <question_version><question_versions id="${qv}"><version>1</version><status>ready</status>
        <questions><question id="${qid}">
          <parent>0</parent><name>${xmlEsc(q.id)}</name>
          <questiontext>${xmlEsc(htmlPara(q.stem))}</questiontext><questiontextformat>1</questiontextformat>
          <generalfeedback>${xmlEsc(htmlPara(q.explanation))}</generalfeedback><generalfeedbackformat>1</generalfeedbackformat>
          <defaultmark>1.0000000</defaultmark><penalty>0.3333333</penalty><qtype>${q.type}</qtype>
          <length>1</length><stamp>${stamp}</stamp>
          <timecreated>${p.ts}</timecreated><timemodified>${p.ts}</timemodified>
          <createdby>2</createdby><modifiedby>2</modifiedby>
          ${plugin}
          <plugin_qbank_comment_question><comments></comments></plugin_qbank_comment_question>
        </question></questions></question_versions></question_version>
      </question_bank_entry>\n`;
      })
      .join('');

  let questionCategoriesXml =
    catXml(p, catTop, 'top', 0, 0, '', '') +
    catXml(p, catDefault, `Por defecto en ${p.name}`, catTop, 999, `Categoría por defecto para preguntas compartidas en el contexto ${p.name}.`, '');
  groups.forEach((g, gi) => {
    questionCategoriesXml += catXml(p, g.id, g.name, catTop, gi + 1, '', '');
    g.leaves.forEach((leaf, li) => {
      questionCategoriesXml += catXml(p, leaf.id, leaf.name, g.id, li + 1, '', entriesOf(leaf));
    });
  });
  const quizXml = quizActivityXmlV3(p, instances);
  return {
    quizXml,
    questionCategoriesXml,
    categoryIds: [catTop, catDefault, ...groups.flatMap((g) => [g.id, ...g.leaves.map((l) => l.id)])],
    questionCount: slotCount,
    bankSize: doc.questions.length,
    leaves: leaves.map((l) => ({ category: l.name, type: l.type, slots: l.slots })),
  };
}

// ─── SCORM ──────────────────────────────────────────────────────────────────

export interface ScormManifestIds {
  manifest: string;
  organization: string;
  item: string;
  launch: string;
  title: string;
}

function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/**
 * Identificadores del `imsmanifest.xml` que el `scorm.xml` del backup debe
 * reproducir (los `scoes` se restauran desde el XML, no re-parseando el
 * paquete). Falla fuerte si el manifiesto no tiene la forma SCORM 1.2 mínima.
 */
export function parseScormManifestIds(xml: string): ScormManifestIds {
  const mTag = /<manifest\b[^>]*>/i.exec(xml)?.[0];
  const oTag = /<organization\b[^>]*>/i.exec(xml)?.[0];
  const iTag = /<item\b[^>]*identifierref\s*=\s*"[^"]*"[^>]*>/i.exec(xml)?.[0];
  const manifest = mTag ? attrOf(mTag, 'identifier') : null;
  const organization = oTag ? attrOf(oTag, 'identifier') : null;
  const item = iTag ? attrOf(iTag, 'identifier') : null;
  const ref = iTag ? attrOf(iTag, 'identifierref') : null;
  let launch: string | null = null;
  if (ref) {
    const rTag = new RegExp(`<resource\\b[^>]*identifier\\s*=\\s*"${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'i').exec(xml)?.[0];
    launch = rTag ? attrOf(rTag, 'href') : null;
  }
  const title = /<organization\b[^>]*>\s*<title>([^<]*)<\/title>/i.exec(xml)?.[1] ?? 'Actividad';
  const missing = [
    ['manifest@identifier', manifest],
    ['organization@identifier', organization],
    ['item@identifier', item],
    ['resource@href', launch],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`SCORM_MANIFEST_INVALID: faltan ${missing.join(', ')} en imsmanifest.xml`);
  return { manifest: manifest as string, organization: organization as string, item: item as string, launch: launch as string, title };
}

export interface ScormV3Input {
  aid: number;
  mid: number;
  ctx: number;
  name: string;
  introHtml: string;
  zipName: string;
  zipHash: string;
  ids: ScormManifestIds;
  scoOrg: number;
  scoItem: number;
  scoD1: number;
  scoD2: number;
  whatgrade: GradeMethod;
  maxattempt: number;
  ts: number;
}

export function scormActivityXmlV3(p: ScormV3Input): string {
  const base = `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="scorm" contextid="${p.ctx}">
  <scorm id="${p.aid}">
    <name>${xmlEsc(p.name)}</name>
    <scormtype>local</scormtype>
    <reference>${xmlEsc(p.zipName)}</reference>
    <intro>${xmlEsc(p.introHtml)}</intro>
    <introformat>1</introformat>
    <version>SCORM_1.2</version>
    <maxgrade>100</maxgrade>
    <grademethod>1</grademethod>
    <whatgrade>0</whatgrade>
    <maxattempt>0</maxattempt>
    <forcecompleted>0</forcecompleted>
    <forcenewattempt>0</forcenewattempt>
    <lastattemptlock>0</lastattemptlock>
    <masteryoverride>1</masteryoverride>
    <displayattemptstatus>1</displayattemptstatus>
    <displaycoursestructure>0</displaycoursestructure>
    <updatefreq>0</updatefreq>
    <sha1hash>${p.zipHash}</sha1hash>
    <md5hash></md5hash>
    <revision>1</revision>
    <launch>${p.scoItem}</launch>
    <skipview>0</skipview>
    <hidebrowse>0</hidebrowse>
    <hidetoc>0</hidetoc>
    <nav>1</nav>
    <navpositionleft>-100</navpositionleft>
    <navpositiontop>-100</navpositiontop>
    <auto>0</auto>
    <popup>0</popup>
    <options></options>
    <width>100</width>
    <height>500</height>
    <timeopen>0</timeopen>
    <timeclose>0</timeclose>
    <timemodified>${p.ts}</timemodified>
    <completionstatusrequired>6</completionstatusrequired>
    <completionscorerequired>$@NULL@$</completionscorerequired>
    <completionstatusallscos>0</completionstatusallscos>
    <autocommit>0</autocommit>
    <scoes>
      <sco id="${p.scoOrg}">
        <manifest>${xmlEsc(p.ids.manifest)}</manifest>
        <organization></organization>
        <parent>/</parent>
        <identifier>${xmlEsc(p.ids.organization)}</identifier>
        <launch></launch>
        <scormtype></scormtype>
        <title>${xmlEsc(p.ids.title)}</title>
        <sortorder>1</sortorder>
        <sco_datas></sco_datas>
        <seq_ruleconds></seq_ruleconds>
        <seq_rolluprules></seq_rolluprules>
        <seq_objectives></seq_objectives>
        <sco_tracks></sco_tracks>
      </sco>
      <sco id="${p.scoItem}">
        <manifest>${xmlEsc(p.ids.manifest)}</manifest>
        <organization>${xmlEsc(p.ids.organization)}</organization>
        <parent>${xmlEsc(p.ids.organization)}</parent>
        <identifier>${xmlEsc(p.ids.item)}</identifier>
        <launch>${xmlEsc(p.ids.launch)}</launch>
        <scormtype>sco</scormtype>
        <title>${xmlEsc(p.name)}</title>
        <sortorder>2</sortorder>
        <sco_datas>
          <sco_data id="${p.scoD1}"><name>isvisible</name><value>true</value></sco_data>
          <sco_data id="${p.scoD2}"><name>parameters</name><value></value></sco_data>
        </sco_datas>
        <seq_ruleconds></seq_ruleconds>
        <seq_rolluprules></seq_rolluprules>
        <seq_objectives></seq_objectives>
        <sco_tracks></sco_tracks>
      </sco>
    </scoes>
  </scorm>
</activity>`;
  return applyXmlFields(
    base,
    scormAssessmentFields({ maxgrade: 100, grademethod: 'highest', whatgrade: p.whatgrade, maxattempt: p.maxattempt, masteryoverride: 1 }),
  );
}
