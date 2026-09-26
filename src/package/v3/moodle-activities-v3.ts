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
import { GiftQuestion, parseGIFT, xmlEsc } from '../mbz-common';
import { applyXmlFields, quizAttemptsXmlFields, scormAssessmentFields } from '../assessment';
import type { GradeMethod } from '../../modules/course-profiles/course-profiles';

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
  gift: string;
  attempts: number;
  grademethod: GradeMethod;
  ts: number;
  /** Semilla estable para los stamps (p.ej. el item_key). */
  stampSeed: string;
  ids: IdAllocator;
}

export interface QuizV3Output {
  quizXml: string;
  questionCategoriesXml: string;
  categoryIds: [number, number, number];
  questionCount: number;
}

export function buildQuizV3(p: QuizV3Input): QuizV3Output {
  const qs: GiftQuestion[] = parseGIFT(p.gift);
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

  const quizXmlBase = `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="quiz" contextid="${p.ctx}">
  <quiz id="${p.aid}">
    <name>${xmlEsc(p.name)}</name><intro>${xmlEsc(p.introHtml)}</intro><introformat>1</introformat>
    <timeopen>0</timeopen><timeclose>0</timeclose><timelimit>0</timelimit>
    <overduehandling>autosubmit</overduehandling><graceperiod>0</graceperiod>
    <preferredbehaviour>deferredfeedback</preferredbehaviour><canredoquestions>0</canredoquestions>
    <attempts_number>0</attempts_number><attemptonlast>0</attemptonlast>
    <grademethod>1</grademethod><decimalpoints>2</decimalpoints><questiondecimalpoints>-1</questiondecimalpoints>
    <reviewattempt>69888</reviewattempt><reviewcorrectness>4352</reviewcorrectness>
    <reviewmaxmarks>69888</reviewmaxmarks><reviewmarks>4352</reviewmarks>
    <reviewspecificfeedback>4352</reviewspecificfeedback><reviewgeneralfeedback>4352</reviewgeneralfeedback>
    <reviewrightanswer>4352</reviewrightanswer><reviewoverallfeedback>4352</reviewoverallfeedback>
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
    <feedbacks></feedbacks>
    <overrides></overrides><grades></grades><attempts></attempts>
  </quiz>
</activity>`;
  const quizXml = applyXmlFields(quizXmlBase, quizAttemptsXmlFields({ attempts: p.attempts, grademethod: p.grademethod }));

  const catXml = (id: number, name: string, parent: number, sortorder: number, info: string, qbe: string) => `  <question_category id="${id}">
    <name>${xmlEsc(name)}</name>
    <contextid>${p.ctx}</contextid><contextlevel>70</contextlevel><contextinstanceid>${p.mid}</contextinstanceid>
    <info>${xmlEsc(info)}</info><infoformat>0</infoformat>
    <stamp>cursia.v3+cat+${sha1(`${p.stampSeed}#cat${id}`).slice(0, 20)}</stamp>
    <parent>${parent}</parent><sortorder>${sortorder}</sortorder><idnumber>$@NULL@$</idnumber>
    <question_bank_entries>${qbe ? `\n${qbe}    ` : ''}</question_bank_entries>
  </question_category>
`;
  const questionCategoriesXml =
    catXml(catTop, 'top', 0, 0, '', '') +
    catXml(catDefault, `Por defecto en ${p.name}`, catTop, 999, `Categoría por defecto para preguntas compartidas en el contexto ${p.name}.`, '') +
    catXml(cat, p.name, catTop, 999, '', entries);
  return { quizXml, questionCategoriesXml, categoryIds: [catTop, catDefault, cat], questionCount: qs.length };
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
