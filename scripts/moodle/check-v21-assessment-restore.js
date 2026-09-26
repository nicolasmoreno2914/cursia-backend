#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R6: verificación en el Moodle 4.5 LOCAL desechable de los
// generadores de src/package/assessment (compilados en dist/).
//
// Para cada configuración (passingGrade 60/70/80 × con/sin examen final):
//   1. arma un .mbz mínimo con los generadores (1 sección: SCORM, H5P, quiz de
//      módulo con 2 preguntas y, si aplica, quiz final);
//   2. lo restaura con restore-and-inspect.sh (curso nuevo, categoría 1);
//   3. vía PHP CLI (v21-assessment-inspect.php) lee lo restaurado, simula
//      notas y completion;
//   4. compara con lo esperado según el perfil resuelto.
//
// Nunca borra datos ni cambia configuración del sitio; no levanta servidor web.
// Requisitos: Postgres del Moodle local corriendo (127.0.0.1:5570), `npm run build`.
//
// Variables (con defaults al scratchpad de esta sesión):
//   MOODLE_LOCAL_DIR  dir con restore-and-inspect.sh, php.ini y source/
//   R0_DIR            dir con sco_mastery.zip y qs_contentOnly.h5p
//   R6_OUT_DIR        dónde escribir los .mbz y los JSON de resultado
//   PHP_BIN           php 8.3

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '../..');
const SCRATCH = '/private/tmp/claude-501/-Users-nicolas-Documents-Claude-course-gen/c3707ccd-9a84-4474-8052-2f6dfeb251b1/scratchpad';
const MOODLE_LOCAL_DIR = process.env.MOODLE_LOCAL_DIR || path.join(SCRATCH, 'moodle-local');
const R0_DIR = process.env.R0_DIR || path.join(SCRATCH, 'v21audit/r0');
const OUT_DIR = process.env.R6_OUT_DIR || path.join(MOODLE_LOCAL_DIR, 'r6-assessment-out');
const PHP = process.env.PHP_BIN || '/opt/homebrew/opt/php@8.3/bin/php';

const A = require(path.join(ROOT, 'dist/package/assessment/index.js'));
const P = require(path.join(ROOT, 'dist/modules/course-profiles/course-profiles.js'));
const { xmlEsc, esc, sha1Buf, MOODLE_VERSIONS, writeActFiles } = require(path.join(ROOT, 'dist/package/mbz-common.js'));

let failures = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'distinto'}: esperado ${e}, recibido ${a}`);
}
function near(actual, expected, msg, tol = 0.01) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tol) {
    throw new Error(`${msg || 'distinto'}: esperado ≈${expected}, recibido ${actual}`);
  }
}

const MV = MOODLE_VERSIONS['4.5'];
const TS = 1790000000;
const NAMES = { activity: 'R6 SCORM actividad', video: 'R6 Video H5P', exam: 'R6 Examen de módulo', finalExam: 'R6 Examen final' };
const MODNAME = { activity: 'scorm', video: 'h5pactivity', exam: 'quiz', finalExam: 'quiz' };
const COMPLETE_PASS = 2;
const COMPLETE_FAIL = 3;
const INCOMPLETE = 0;

// ── Plantillas mínimas del fixture (no son código de producto) ─────────────
const quizXmlTemplate = (p) => `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="quiz" contextid="${p.ctx}">
  <quiz id="${p.aid}">
    <name>${xmlEsc(p.name)}</name><intro>${xmlEsc('<p>' + p.name + '</p>')}</intro><introformat>1</introformat>
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
    <timecreated>${TS}</timecreated><timemodified>${TS}</timemodified>
    <password></password><subnet></subnet><browsersecurity>-</browsersecurity>
    <delay1>0</delay1><delay2>0</delay2><showuserpicture>0</showuserpicture><showblocks>0</showblocks>
    <completionattemptsexhausted>0</completionattemptsexhausted><completionminattempts>0</completionminattempts>
    <allowofflineattempts>0</allowofflineattempts>
    <subplugin_quizaccess_seb_quiz></subplugin_quizaccess_seb_quiz>
    <quiz_grade_items></quiz_grade_items>
    <question_instances>
${[0, 1].map((i) => `      <question_instance id="${p.mid * 10 + i}">
        <quizid>${p.aid}</quizid><slot>${i + 1}</slot><page>1</page>
        <displaynumber>$@NULL@$</displaynumber><requireprevious>0</requireprevious>
        <maxmark>50.0000000</maxmark><quizgradeitemid>$@NULL@$</quizgradeitemid>
        <question_reference id="${p.mid * 10 + i}">
          <usingcontextid>${p.ctx}</usingcontextid><component>mod_quiz</component>
          <questionarea>slot</questionarea><questionbankentryid>${p.mid * 10 + i}</questionbankentryid>
          <version>$@NULL@$</version>
        </question_reference>
      </question_instance>`).join('\n')}
    </question_instances>
    <sections><section id="${p.aid}"><firstslot>1</firstslot><heading></heading><shufflequestions>0</shufflequestions></section></sections>
    <feedbacks></feedbacks>
    <overrides></overrides><grades></grades><attempts></attempts>
  </quiz>
</activity>`;

const questionCategoriesXml = (p) => {
  const entries = [0, 1].map((i) => {
    const id = p.mid * 10 + i;
    return `      <question_bank_entry id="${id}">
        <questioncategoryid>${p.mid * 100 + 3}</questioncategoryid><idnumber>$@NULL@$</idnumber><ownerid>2</ownerid>
        <question_version><question_versions id="${id}"><version>1</version><status>ready</status>
        <questions><question id="${id}">
          <parent>0</parent><name>P${i + 1}</name>
          <questiontext>${xmlEsc(`Pregunta ${i + 1} de ${p.name}`)}</questiontext><questiontextformat>0</questiontextformat>
          <generalfeedback></generalfeedback><generalfeedbackformat>0</generalfeedbackformat>
          <defaultmark>1.0000000</defaultmark><penalty>1.0000000</penalty><qtype>truefalse</qtype>
          <length>1</length><stamp>cursia.r6+${p.mid}+${i}</stamp>
          <timecreated>${TS}</timecreated><timemodified>${TS}</timemodified>
          <createdby>2</createdby><modifiedby>2</modifiedby>
          <plugin_qtype_truefalse_question><answers><answer id="${id * 2}"><answertext>Verdadero</answertext><answerformat>0</answerformat><fraction>1.0000000</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer><answer id="${id * 2 + 1}"><answertext>Falso</answertext><answerformat>0</answerformat><fraction>0.0000000</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer></answers><truefalse id="${id}"><trueanswer>${id * 2}</trueanswer><falseanswer>${id * 2 + 1}</falseanswer><showstandardinstruction>0</showstandardinstruction></truefalse></plugin_qtype_truefalse_question>
          <plugin_qbank_comment_question><comments></comments></plugin_qbank_comment_question>
        </question></questions></question_versions></question_version>
      </question_bank_entry>`;
  }).join('\n');
  const cat = (id, name, parent, sortorder, qbe) => `  <question_category id="${id}">
    <name>${xmlEsc(name)}</name>
    <contextid>${p.ctx}</contextid><contextlevel>70</contextlevel><contextinstanceid>${p.mid}</contextinstanceid>
    <info></info><infoformat>0</infoformat>
    <stamp>cursia.r6+cat+${id}</stamp>
    <parent>${parent}</parent><sortorder>${sortorder}</sortorder><idnumber>$@NULL@$</idnumber>
    <question_bank_entries>${qbe ? '\n' + qbe + '\n    ' : ''}</question_bank_entries>
  </question_category>
`;
  return cat(p.mid * 100 + 1, 'top', 0, 0, '') + cat(p.mid * 100 + 2, 'Por defecto en ' + p.name, p.mid * 100 + 1, 999, '')
    + cat(p.mid * 100 + 3, p.name, p.mid * 100 + 1, 999, entries);
};

const scormXmlTemplate = (p) => `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="scorm" contextid="${p.ctx}">
  <scorm id="${p.aid}">
    <name>${xmlEsc(p.name)}</name>
    <scormtype>local</scormtype>
    <reference>sco.zip</reference>
    <intro></intro>
    <introformat>1</introformat>
    <version>SCORM_1.2</version>
    <maxgrade>0</maxgrade>
    <grademethod>0</grademethod>
    <whatgrade>0</whatgrade>
    <maxattempt>0</maxattempt>
    <forcecompleted>0</forcecompleted>
    <forcenewattempt>0</forcenewattempt>
    <lastattemptlock>0</lastattemptlock>
    <masteryoverride>0</masteryoverride>
    <displayattemptstatus>1</displayattemptstatus>
    <displaycoursestructure>0</displaycoursestructure>
    <updatefreq>0</updatefreq>
    <sha1hash>${p.zipHash}</sha1hash>
    <md5hash></md5hash>
    <revision>1</revision>
    <launch>${p.mid * 10 + 2}</launch>
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
    <timemodified>${TS}</timemodified>
    <completionstatusrequired>6</completionstatusrequired>
    <completionscorerequired>50</completionscorerequired>
    <completionstatusallscos>0</completionstatusallscos>
    <autocommit>0</autocommit>
    <scoes>
      <sco id="${p.mid * 10 + 1}">
        <manifest>r0</manifest><organization></organization><parent>/</parent><identifier>o</identifier>
        <launch></launch><scormtype></scormtype><title>R0</title><sortorder>1</sortorder>
        <sco_datas></sco_datas><seq_ruleconds></seq_ruleconds><seq_rolluprules></seq_rolluprules><seq_objectives></seq_objectives><sco_tracks></sco_tracks>
      </sco>
      <sco id="${p.mid * 10 + 2}">
        <manifest>r0</manifest><organization>o</organization><parent>o</parent><identifier>i1</identifier>
        <launch>index.html</launch><scormtype>sco</scormtype><title>R0 SCO</title><sortorder>2</sortorder>
        <sco_datas>
          <sco_data id="${p.mid * 10 + 3}"><name>isvisible</name><value>true</value></sco_data>
          <sco_data id="${p.mid * 10 + 4}"><name>parameters</name><value></value></sco_data>
        </sco_datas>
        <seq_ruleconds></seq_ruleconds><seq_rolluprules></seq_rolluprules><seq_objectives></seq_objectives><sco_tracks></sco_tracks>
      </sco>
    </scoes>
  </scorm>
</activity>`;

const inforef = (fileIds, gradeItemId, qcats) => `<?xml version="1.0" encoding="UTF-8"?>
<inforef>
${fileIds.length ? `  <fileref>\n${fileIds.map((id) => `    <file><id>${id}</id></file>`).join('\n')}\n  </fileref>\n` : ''}  <grade_itemref>
    <grade_item><id>${gradeItemId}</id></grade_item>
  </grade_itemref>
${qcats ? `  <question_categoryref>\n${qcats.map((id) => `    <question_category><id>${id}</id></question_category>`).join('\n')}\n  </question_categoryref>\n` : ''}</inforef>`;

// ── Armado del .mbz mínimo ────────────────────────────────────────────────
async function buildMbz(cfg, resolved) {
  const zip = new JSZip();
  const scoZip = fs.readFileSync(path.join(R0_DIR, 'sco_mastery.zip'));
  const h5p = fs.readFileSync(path.join(R0_DIR, 'qs_contentOnly.h5p'));
  const scoInner = await JSZip.loadAsync(scoZip);
  const scoFiles = {};
  for (const n of Object.keys(scoInner.files)) if (!scoInner.files[n].dir) scoFiles[n] = await scoInner.files[n].async('nodebuffer');

  const SEC0 = 1000;
  const SEC1 = 1001;
  const COURSE_CAT = 1;
  const CAT_ID = { practice: 2, moduleExams: 3, finalExam: 4 };
  const CAT_ITEM = { practice: 2, moduleExams: 3, finalExam: 4 };
  const kinds = cfg.hasFinalExam ? ['activity', 'video', 'exam', 'finalExam'] : ['activity', 'video', 'exam'];
  const acts = kinds.map((kind, i) => ({ kind, mid: 101 + i, aid: 1 + i, ctx: 201 + i, gi: 11 + i, name: NAMES[kind], modname: MODNAME[kind] }));
  const files = [];
  let fileId = 1;
  const addFile = (ctx, comp, area, name, data, mime) => {
    const hash = sha1Buf(data);
    zip.file(`files/${hash.slice(0, 2)}/${hash}`, data);
    files.push({ id: fileId, hash, ctx, comp, area, name, size: data.length, mime });
    return fileId++;
  };
  const addDir = (ctx, comp, area) => {
    files.push({ id: fileId, hash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709', ctx, comp, area, name: '.', size: 0, mime: null });
    return fileId++;
  };

  let questionsXml = '<?xml version="1.0" encoding="UTF-8"?>\n<question_categories>\n';
  acts.forEach((a, i) => {
    const dir = `activities/${a.modname}_${a.mid}`;
    const k = resolved.kinds[a.kind];
    zip.file(`${dir}/module.xml`, A.gradedModuleXml({ mid: a.mid, modname: a.modname, secnum: 1, sectionId: SEC1, ts: TS, bv: MV.bv, passGradeRequired: true }));
    zip.file(`${dir}/grades.xml`, A.gradeItemXml({
      gradeItemId: a.gi, itemName: a.name, itemModule: a.modname, aid: a.aid, ts: TS, grademax: 100,
      gradepass: k.passingGrade, categoryId: CAT_ID[k.category], sortorder: 10 + i,
    }));
    writeActFiles(zip, dir);
    if (a.modname === 'scorm') {
      const ids = [addFile(a.ctx, 'mod_scorm', 'package', 'sco.zip', scoZip, 'application/zip'), addDir(a.ctx, 'mod_scorm', 'package')];
      for (const [n, data] of Object.entries(scoFiles)) ids.push(addFile(a.ctx, 'mod_scorm', 'content', n, data, n.endsWith('.xml') ? 'application/xml' : 'text/html'));
      ids.push(addDir(a.ctx, 'mod_scorm', 'content'));
      const fields = A.scormAssessmentFields({ maxgrade: 100, grademethod: 'highest', whatgrade: k.gradeMethod, maxattempt: k.attempts, masteryoverride: 1 });
      zip.file(`${dir}/scorm.xml`, A.applyXmlFields(scormXmlTemplate({ ...a, zipHash: sha1Buf(scoZip) }), fields));
      zip.file(`${dir}/inforef.xml`, inforef(ids, a.gi));
    } else if (a.modname === 'h5pactivity') {
      const ids = [addFile(a.ctx, 'mod_h5pactivity', 'package', 'qs_contentOnly.h5p', h5p, 'application/zip.h5p'), addDir(a.ctx, 'mod_h5pactivity', 'package')];
      zip.file(`${dir}/h5pactivity.xml`, A.h5pactivityXml({
        aid: a.aid, mid: a.mid, ctx: a.ctx, name: a.name, intro: '<p>Video interactivo</p>', grade: 100,
        grademethod: k.gradeMethod, enabletracking: 1, reviewmode: 1,
        displayoptions: { frame: false, download: false, embed: false, copyright: false }, ts: TS,
      }));
      zip.file(`${dir}/inforef.xml`, inforef(ids, a.gi));
    } else {
      zip.file(`${dir}/quiz.xml`, A.applyXmlFields(quizXmlTemplate(a), A.quizAttemptsXmlFields({ attempts: k.attempts, grademethod: k.gradeMethod })));
      zip.file(`${dir}/inforef.xml`, inforef([], a.gi, [a.mid * 100 + 1, a.mid * 100 + 2, a.mid * 100 + 3]));
      questionsXml += questionCategoriesXml(a);
    }
  });
  questionsXml += '</question_categories>';
  zip.file('questions.xml', questionsXml);

  zip.file('gradebook.xml', A.gradebookXml({
    ts: TS, courseGradepass: resolved.courseGradepass, aggregation: 'weighted_mean', courseCategoryId: COURSE_CAT, courseItemId: 1,
    categories: resolved.categories.map((c) => ({ id: CAT_ID[c.key], fullname: c.fullname, weight: c.weight, gradeItemId: CAT_ITEM[c.key] })),
  }));
  const criteria = A.completionCriteriaFor(acts.map((a) => ({ moduleId: a.mid, modname: a.modname, kind: a.kind })), resolved.courseCompletion);
  zip.file('completion.xml', A.courseCompletionXml({
    criteria, aggregation: 'all', requireCourseGradePass: resolved.courseCompletion.requireCourseGradePass,
    courseGradepass: resolved.courseCompletion.courseGradepass,
  }));

  const secXml = (id, num, seq) => `<?xml version="1.0" encoding="UTF-8"?>
<section id="${id}">
  <number>${num}</number><name>${num ? 'Módulo R6' : '$@NULL@$'}</name><summary></summary><summaryformat>1</summaryformat>
  <sequence>${seq}</sequence><visible>1</visible><availabilityjson>$@NULL@$</availabilityjson>
  <component>$@NULL@$</component><itemid>$@NULL@$</itemid><timemodified>${TS}</timemodified>
</section>`;
  zip.file(`sections/section_${SEC0}/section.xml`, secXml(SEC0, 0, ''));
  zip.file(`sections/section_${SEC1}/section.xml`, secXml(SEC1, 1, acts.map((a) => a.mid).join(',')));
  for (const s of [SEC0, SEC1]) zip.file(`sections/section_${s}/inforef.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n</inforef>');

  const title = `R6 assessment ${cfg.id}`;
  zip.file('course/course.xml', `<?xml version="1.0" encoding="UTF-8"?>
<course id="1" contextid="1">
  <shortname>${esc(title)}</shortname><fullname>${esc(title)}</fullname>
  <idnumber></idnumber><summary></summary><summaryformat>1</summaryformat>
  <format>topics</format><showgrades>1</showgrades><newsitems>0</newsitems>
  <startdate>${TS}</startdate><enddate>0</enddate><marker>0</marker>
  <maxbytes>0</maxbytes><legacyfiles>0</legacyfiles><showreports>0</showreports>
  <visible>1</visible><groupmode>0</groupmode><groupmodeforce>0</groupmodeforce>
  <defaultgroupingid>0</defaultgroupingid><lang>es</lang><theme></theme>
  <timecreated>${TS}</timecreated><timemodified>${TS}</timemodified>
  <requested>0</requested><showactivitydates>1</showactivitydates>
  <showcompletionconditions>1</showcompletionconditions>
  <pdfexportfont>$@NULL@$</pdfexportfont>
  <enablecompletion>1</enablecompletion><completionnotify>0</completionnotify>
  <tags></tags><customfields></customfields>
  <courseformatoptions></courseformatoptions>
</course>`);
  zip.file('course/inforef.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n</inforef>');
  zip.file('course/roles.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>');
  zip.file('course/completiondefaults.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion_defaults>\n</course_completion_defaults>');
  zip.file('roles.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<roles_definition>\n</roles_definition>');
  zip.file('scales.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<scales_definition>\n</scales_definition>');
  zip.file('outcomes.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<outcomes_definition>\n</outcomes_definition>');
  zip.file('badges.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<badges>\n</badges>');
  zip.file('users.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<users>\n</users>');
  zip.file('grade_history.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>');
  zip.file('groups.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<groups>\n  <groupings>\n  </groupings>\n</groups>');

  let fx = '<?xml version="1.0" encoding="UTF-8"?>\n<files>\n';
  for (const f of files) {
    fx += `  <file id="${f.id}">\n    <contenthash>${f.hash}</contenthash>\n    <contextid>${f.ctx}</contextid>\n    <component>${f.comp}</component>\n    <filearea>${f.area}</filearea>\n    <itemid>0</itemid>\n    <filepath>/</filepath>\n    <filename>${xmlEsc(f.name)}</filename>\n    <userid>$@NULL@$</userid>\n    <filesize>${f.size}</filesize>\n    <mimetype>${f.mime ?? '$@NULL@$'}</mimetype>\n    <status>0</status>\n    <timecreated>${TS}</timecreated>\n    <timemodified>${TS}</timemodified>\n    <source>$@NULL@$</source>\n    <author>$@NULL@$</author>\n    <license>$@NULL@$</license>\n    <sortorder>0</sortorder>\n    <repositorytype>$@NULL@$</repositorytype>\n    <repositoryid>$@NULL@$</repositoryid>\n    <reference>$@NULL@$</reference>\n  </file>\n`;
  }
  zip.file('files.xml', fx + '</files>');

  const setting = (level, extra, name, value) => `    <setting>\n      <level>${level}</level>\n${extra}      <name>${name}</name>\n      <value>${value}</value>\n    </setting>\n`;
  let sett = '';
  const rootSettings = { filename: 'r6.mbz', users: '0', anonymize: '0', role_assignments: '0', activities: '1', blocks: '0', files: '1',
    filters: '0', comments: '0', badges: '0', calendarevents: '0', userscompletion: '0', logs: '0', grade_histories: '0',
    questionbank: '1', groups: '0', competencies: '0', customfield: '0', contentbankcontent: '0', xapistate: '0', legacyfiles: '0' };
  for (const [k, v] of Object.entries(rootSettings)) sett += setting('root', '', k, v);
  for (const s of [SEC0, SEC1]) {
    sett += setting('section', `      <section>section_${s}</section>\n`, `section_${s}_included`, 1);
    sett += setting('section', `      <section>section_${s}</section>\n`, `section_${s}_userinfo`, 0);
  }
  for (const a of acts) {
    const pre = `${a.modname}_${a.mid}`;
    sett += setting('activity', `      <activity>${pre}</activity>\n`, `${pre}_included`, 1);
    sett += setting('activity', `      <activity>${pre}</activity>\n`, `${pre}_userinfo`, 0);
  }
  zip.file('moodle_backup.xml', `<?xml version="1.0" encoding="UTF-8"?>
<moodle_backup>
<information>
  <name>r6.mbz</name>
  <moodle_version>${MV.mv}</moodle_version><moodle_release>${MV.mr}</moodle_release>
  <backup_version>${MV.bv}</backup_version><backup_release>${MV.br}</backup_release>
  <backup_date>${TS}</backup_date><mnet_remoteusers>0</mnet_remoteusers><include_files>1</include_files>
  <include_file_references_to_external_content>0</include_file_references_to_external_content>
  <original_wwwroot>https://cursia.invalid</original_wwwroot>
  <original_site_identifier_hash>r6r6r6r6r6r6r6r6r6r6r6r6r6r6r6r6</original_site_identifier_hash>
  <original_course_id>1</original_course_id><original_course_format>topics</original_course_format>
  <original_course_fullname>${esc(title)}</original_course_fullname><original_course_shortname>${esc(title)}</original_course_shortname>
  <original_course_startdate>${TS}</original_course_startdate><original_course_enddate>0</original_course_enddate>
  <original_course_contextid>1</original_course_contextid><original_system_contextid>1</original_system_contextid>
  <details><detail backup_id="r6${cfg.id}"><type>course</type><format>moodle2</format><interactive>1</interactive><mode>70</mode><execution>2</execution><executiontime>0</executiontime></detail></details>
  <contents>
    <activities>
${acts.map((a) => `      <activity><moduleid>${a.mid}</moduleid><sectionid>${SEC1}</sectionid><modulename>${a.modname}</modulename><title>${esc(a.name)}</title><directory>activities/${a.modname}_${a.mid}</directory><insubsection></insubsection></activity>`).join('\n')}
    </activities>
    <sections>
${[SEC0, SEC1].map((s, i) => `      <section><sectionid>${s}</sectionid><title>${i}</title><directory>sections/section_${s}</directory><parentcmid></parentcmid><modname></modname></section>`).join('\n')}
    </sections>
    <course><courseid>1</courseid><title>${esc(title)}</title><directory>course</directory></course>
  </contents>
  <settings>
${sett}  </settings>
</information>
</moodle_backup>`);

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buf, acts, criteria };
}

// ── Configuraciones: passingGrade 60/70/80 × con/sin final ────────────────
function profileFor(cfg) {
  const p = P.defaultAssessmentProfile({ finalExam: cfg.hasFinalExam });
  p.passingGrade = cfg.passingGrade;
  Object.assign(p.overrides, cfg.overrides || {});
  Object.assign(p.attempts, cfg.attempts || {});
  Object.assign(p.gradeMethod, cfg.gradeMethod || {});
  if (cfg.weights) p.categoryWeights = cfg.weights;
  Object.assign(p.courseCompletion, cfg.courseCompletion || {});
  return p;
}
const CONFIGS = [
  { id: 'p60-final', passingGrade: 60, hasFinalExam: true, attempts: { activity: 2, exam: 2 }, gradeMethod: { activity: 'last', exam: 'average' } },
  { id: 'p60-nofinal', passingGrade: 60, hasFinalExam: false },
  { id: 'p70-final', passingGrade: 70, hasFinalExam: true, courseCompletion: { requireCourseGradePass: true } },
  { id: 'p70-nofinal', passingGrade: 70, hasFinalExam: false, courseCompletion: { requireExams: false }, gradeMethod: { video: 'average' } },
  { id: 'p80-final', passingGrade: 80, hasFinalExam: true, overrides: { video: 65, finalExam: 90 }, weights: { practice: 20, moduleExams: 50, finalExam: 30 }, gradeMethod: { finalExam: 'first' }, attempts: { finalExam: 1 } },
  { id: 'p80-nofinal', passingGrade: 80, hasFinalExam: false, overrides: { exam: 75 }, weights: { practice: 50, moduleExams: 50 }, courseCompletion: { requireCourseGradePass: true } },
];
const DELTA = { activity: 5, video: 10, exam: 0, finalExam: 3 };
const WHATGRADE = { highest: 0, average: 1, first: 2, last: 3 };
const QUIZ_GM = { highest: 1, average: 2, first: 3, last: 4 };
const H5P_GM = { highest: 1, average: 2, last: 3, first: 4 };

function restore(mbzPath) {
  const sh = path.join(MOODLE_LOCAL_DIR, 'restore-and-inspect.sh');
  let stdout;
  let stderr = '';
  try {
    const r = require('child_process').spawnSync(sh, [mbzPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    stdout = r.stdout;
    stderr = r.stderr;
    if (r.status !== 0) throw new Error(`restore-and-inspect.sh salió con ${r.status}: ${stderr.slice(-800)}`);
  } catch (e) {
    throw e;
  }
  const m = stderr.match(/Restored course id: (\d+)/);
  if (!m) throw new Error(`no se pudo leer el course id: ${stderr.slice(-400)}`);
  return { courseid: Number(m[1]), inspect: JSON.parse(stdout), stderr };
}

async function runConfig(cfg) {
  const profile = profileFor(cfg);
  const resolved = A.resolveAssessment(profile, { hasFinalExam: cfg.hasFinalExam, activityEngine: 'scorm' });
  const { buf, acts, criteria } = await buildMbz(cfg, resolved);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mbzPath = path.join(OUT_DIR, `r6-${cfg.id}.mbz`);
  fs.writeFileSync(mbzPath, buf);

  // Plan de notas: "pass" = gradepass efectivo + delta (tope 100); "fail" = gradepass − 10, sin examen final.
  const grades = { pass: {}, fail: {} };
  for (const a of acts) {
    const gp = resolved.kinds[a.kind].passingGrade;
    grades.pass[a.name] = Math.min(100, gp + DELTA[a.kind]);
    grades.fail[a.name] = a.kind === 'finalExam' ? null : Math.max(0, gp - 10);
  }

  const r = restore(mbzPath);
  const inPath = path.join(OUT_DIR, `r6-${cfg.id}.in.json`);
  const outPath = path.join(OUT_DIR, `r6-${cfg.id}.out.json`);
  fs.writeFileSync(inPath, JSON.stringify({ moodleRoot: path.join(MOODLE_LOCAL_DIR, 'source'), courseid: r.courseid, mbz: mbzPath, grades }));
  execFileSync(PHP, ['-c', path.join(MOODLE_LOCAL_DIR, 'php.ini'), path.join(__dirname, 'v21-assessment-inspect.php'), inPath, outPath],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const o = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const tag = `[${cfg.id} → curso ${r.courseid}]`;

  check(`${tag} restore sin warnings (precheck, log del restore, salida CLI)`, () => {
    eq(o.precheck, { warnings: [], errors: [] }, 'precheck');
    eq(o.restoreStatus, 1000, 'estado del controller (1000 = FINISHED_OK)');
    if (!o.restoreLogFound) throw new Error('no se encontró el log del restore');
    eq(o.restoreLogLines, [], 'líneas WARNING/ERROR en el log del restore');
    eq(o.restoreDbLogWarnings, [], 'backup_logs');
    const noisy = r.stderr.split('\n').filter((l) => /warning|notice|debug|error|exception/i.test(l));
    eq(noisy, [], 'salida del CLI');
  });
  check(`${tag} estructura: las ${acts.length} actividades calificables restauradas`, () => {
    eq(Object.fromEntries(Object.entries(r.inspect.modname_counts).sort()), Object.fromEntries(Object.entries(acts.reduce((m, a) => ({ ...m, [a.modname]: (m[a.modname] || 0) + 1 }), {})).sort()), 'modname_counts');
    for (const a of acts) if (!o.cms[a.name]) throw new Error(`falta ${a.name}`);
  });
  check(`${tag} module.xml → completion=2, gradeitemnumber=0, completionpassgrade=1, view=0, showdescription=1`, () => {
    for (const a of acts) {
      const c = o.cms[a.name];
      eq([c.completion, String(c.completiongradeitemnumber), c.completionpassgrade, c.completionview, c.showdescription], [2, '0', 1, 0, 1], a.name);
    }
  });
  check(`${tag} gradepass por ítem = perfil (con overrides), grademax 100, categoría correcta`, () => {
    for (const a of acts) {
      const it = o.items[a.name];
      const k = resolved.kinds[a.kind];
      eq([it.itemmodule, it.gradepass, it.grademax, it.grademin, it.category], [a.modname, k.passingGrade, 100, 0, A.categoryForItem(a.kind)], a.name);
    }
  });
  check(`${tag} categorías: curso media ponderada, pesos ${resolved.categories.map((c) => c.weight).join('/')}`, () => {
    const top = o.categories.find((c) => c.depth === 1);
    eq([top.aggregation, top.aggregateonlygraded], [10, 0], 'categoría del curso');
    const kids = o.categories.filter((c) => c.depth === 2).map((c) => [c.fullname, c.itemAggregationcoef, c.aggregation, c.aggregateonlygraded]);
    eq(kids, resolved.categories.map((c) => [c.fullname, c.weight, 0, 0]));
  });
  check(`${tag} gradepass del curso = ${resolved.courseGradepass}`, () => {
    eq(o.courseItem, { gradepass: resolved.courseGradepass, grademax: 100 });
  });
  check(`${tag} criterios de completion del curso presentes`, () => {
    const exp = criteria.map((c) => ({ criteriatype: 4, module: c.modname, cmName: acts.find((a) => a.mid === c.moduleId).name, gradepass: null }));
    if (resolved.courseCompletion.requireCourseGradePass) exp.push({ criteriatype: 6, module: null, cmName: null, gradepass: resolved.courseGradepass });
    eq(o.criteria, exp);
    eq(o.aggr, [{ criteriatype: null, method: 1 }]);
  });
  check(`${tag} quiz: intentos y método según el perfil; sumgrades/grade 100`, () => {
    for (const a of acts.filter((x) => x.modname === 'quiz')) {
      const k = resolved.kinds[a.kind];
      eq(o.quizzes[a.name], { attempts: k.attempts, grademethod: QUIZ_GM[k.gradeMethod], sumgrades: 100, grade: 100, preferredbehaviour: 'deferredfeedback', slots: 2 }, a.name);
    }
  });
  check(`${tag} scorm/h5pactivity: campos de evaluación restaurados`, () => {
    const k = resolved.kinds.activity;
    eq(o.scorms[NAMES.activity], { maxgrade: 100, grademethod: 1, whatgrade: WHATGRADE[k.gradeMethod], maxattempt: k.attempts, masteryoverride: 1, completionstatusrequired: null, completionscorerequired: null });
    const v = resolved.kinds.video;
    eq(o.h5ps[NAMES.video], { grade: 100, grademethod: H5P_GM[v.gradeMethod], enabletracking: 1, reviewmode: 1, displayoptions: 15, packageFiles: ['qs_contentOnly.h5p'] });
  });

  // Simulación
  const expectState = (who, a) => {
    const g = grades[who][a.name];
    if (g === null) return INCOMPLETE;
    return g >= resolved.kinds[a.kind].passingGrade ? COMPLETE_PASS : COMPLETE_FAIL;
  };
  const expectTotal = (who) => {
    let total = 0;
    for (const c of resolved.categories) {
      const its = acts.filter((a) => resolved.kinds[a.kind].category === c.key);
      const mean = its.reduce((s, a) => s + (grades[who][a.name] ?? 0), 0) / its.length; // aggregateonlygraded=0 → vacío cuenta 0
      total += (c.weight * mean) / 100;
    }
    return total;
  };
  const expectComplete = (who) => {
    const actsOk = criteria.every((c) => expectState(who, acts.find((a) => a.mid === c.moduleId)) === COMPLETE_PASS);
    const gradeOk = !resolved.courseCompletion.requireCourseGradePass || expectTotal(who) >= resolved.courseGradepass;
    return actsOk && gradeOk;
  };
  for (const who of ['pass', 'fail']) {
    check(`${tag} simulación "${who}": notas registradas y COMPLETE_PASS/COMPLETE_FAIL por nota aprobatoria`, () => {
      for (const a of acts) {
        eq(o.sim[who].grades[a.name], grades[who][a.name], `nota ${a.name}`);
        eq(o.sim[who].states[a.name], expectState(who, a), `estado ${a.name} (nota ${grades[who][a.name]}, gradepass ${resolved.kinds[a.kind].passingGrade})`);
      }
    });
    check(`${tag} simulación "${who}": total ponderado del curso ≈ ${expectTotal(who).toFixed(2)}`, () => {
      near(o.sim[who].courseTotal, expectTotal(who), 'total del curso');
    });
    check(`${tag} simulación "${who}": completion del curso = ${expectComplete(who)}`, () => {
      eq(o.sim[who].courseComplete, expectComplete(who));
    });
  }
}

(async () => {
  try {
    execFileSync('pg_isready', ['-h', '127.0.0.1', '-p', '5570'], { stdio: 'ignore' });
  } catch (_) {
    console.error('❌ Postgres del Moodle local no responde en 127.0.0.1:5570 (correr moodle-local/start.sh)');
    process.exit(1);
  }
  for (const cfg of CONFIGS) {
    try {
      await runConfig(cfg);
    } catch (err) {
      failures += 1;
      console.error(`❌ [${cfg.id}] no se pudo completar`);
      console.error(`   ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`\n${passed} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})();
