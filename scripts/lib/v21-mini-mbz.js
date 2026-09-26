/* eslint-disable */
// Cursia V2.1 / R8 — ensamblador MÍNIMO de .mbz SOLO PARA PRUEBAS (no es el
// empaquetador de producción; ese es R12). Un curso con la sección 0 vacía y la
// sección 1 con UNA O VARIAS actividades h5pactivity (buildMiniH5pMbz). El caso
// del video (buildMiniVideoMbz) es una actividad con:
//   grade 100, gradepass 70, completion 2 + completionpassgrade 1,
//   showdescription 1, intro = HTML inline (iframe embed.php + fallback),
//   el mismo .h5p en los fileareas `package` e `intro` (un solo blob).
// Reutiliza los helpers compilados de dist/package/mbz-common.js (xmlEsc real,
// moduleXml/sectionXml/boilerplate) y videoActivityFileEntries de R8.
'use strict';

const path = require('path');
const JSZip = require('jszip');

function load() {
  const dist = path.resolve(__dirname, '..', '..', 'dist/package');
  return { c: require(path.join(dist, 'mbz-common.js')), h: require(path.join(dist, 'h5p/index.js')) };
}

const TS = 1790400000; // fijo: el .mbz de prueba es determinístico
const BOIL = {
  roles: '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>',
  filters: '<?xml version="1.0" encoding="UTF-8"?>\n<filters>\n  <filter_actives>\n  </filter_actives>\n  <filter_configs>\n  </filter_configs>\n</filters>',
  contentbank: '<?xml version="1.0" encoding="UTF-8"?>\n<contents>\n</contents>',
};

/**
 * @param {{ courseTitle: string, activities: Array<{ mid: number, name: string, packageFilename: string, h5p: Buffer,
 *   introHtml?: string, inlineIntroFile?: boolean, showdescription?: number }> }} p
 * @returns {Promise<Buffer>}
 */
async function buildMiniH5pMbz(p) {
  const { c, h } = load();
  const MV = c.resolveMoodleVersion('4.5');
  const S = h.VIDEO_ACTIVITY_MOODLE_SETTINGS;
  const zip = new JSZip();
  const opts = { date: new Date(Date.UTC(2026, 0, 1)), createFolders: false };
  const put = (name, data) => zip.file(name, data, opts);
  const secnum = 1;
  const acts = p.activities;
  if (!acts.length || new Set(acts.map((a) => a.mid)).size !== acts.length) throw new Error('mini-mbz: mids vacíos o duplicados');

  let fileId = 1;
  let filesXml = '<?xml version="1.0" encoding="UTF-8"?>\n<files>\n';
  const blobs = new Set();
  acts.forEach((a, k) => {
    const mid = a.mid;
    const aid = k + 1;
    const ctx = 5000 + mid;
    const gradeItemId = 9000 + mid;
    const dir = `activities/h5pactivity_${mid}`;
    const all = h.videoActivityFileEntries({ packageFilename: a.packageFilename, h5p: a.h5p });
    const entries = a.inlineIntroFile === false ? [all[0]] : all;
    if (!blobs.has(entries[0].blobPath)) {
      put(entries[0].blobPath, a.h5p); // un solo blob aunque haya 2 entradas
      blobs.add(entries[0].blobPath);
    }
    const fileIds = [];
    entries.forEach((e) => {
      const id = fileId++;
      fileIds.push(id);
      filesXml +=
        `  <file id="${id}">\n    <contenthash>${e.contenthash}</contenthash>\n    <contextid>${ctx}</contextid>\n` +
        `    <component>${e.component}</component>\n    <filearea>${e.filearea}</filearea>\n    <itemid>${e.itemid}</itemid>\n` +
        `    <filepath>${e.filepath}</filepath>\n    <filename>${c.xmlEsc(e.filename)}</filename>\n    <userid>$@NULL@$</userid>\n` +
        `    <filesize>${e.filesize}</filesize>\n    <mimetype>${e.mimetype}</mimetype>\n    <status>0</status>\n` +
        `    <timecreated>${TS}</timecreated>\n    <timemodified>${TS}</timemodified>\n` +
        `    <source>$@NULL@$</source>\n    <author>$@NULL@$</author>\n    <license>$@NULL@$</license>\n` +
        `    <sortorder>0</sortorder>\n    <repositorytype>$@NULL@$</repositorytype>\n    <repositoryid>$@NULL@$</repositoryid>\n    <reference>$@NULL@$</reference>\n  </file>\n`;
    });
    const showdesc = a.showdescription === undefined ? S.showdescription : a.showdescription;
    put(`${dir}/h5pactivity.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${aid}" moduleid="${mid}" modulename="h5pactivity" contextid="${ctx}">
  <h5pactivity id="${aid}">
    <name>${c.xmlEsc(a.name)}</name>
    <timecreated>${TS}</timecreated>
    <timemodified>${TS}</timemodified>
    <intro>${c.xmlEsc(a.introHtml || '')}</intro>
    <introformat>1</introformat>
    <grade>${S.grade}</grade>
    <displayoptions>${S.displayoptions}</displayoptions>
    <enabletracking>${S.enabletracking}</enabletracking>
    <grademethod>${S.grademethod}</grademethod>
    <reviewmode>${S.reviewmode}</reviewmode>
    <attempts>
    </attempts>
  </h5pactivity>
</activity>`);
    put(
      `${dir}/module.xml`,
      c
        .moduleXml(mid, 'h5pactivity', secnum, TS, MV.bv)
        .replace('<completion>0</completion>', `<completion>${S.completion}</completion>`)
        .replace('<completiongradeitemnumber>$@NULL@$</completiongradeitemnumber>', `<completiongradeitemnumber>${S.completiongradeitemnumber}</completiongradeitemnumber>`)
        .replace('<completionpassgrade>0</completionpassgrade>', `<completionpassgrade>${S.completionpassgrade}</completionpassgrade>`)
        .replace('<showdescription>0</showdescription>', `<showdescription>${showdesc}</showdescription>`),
    );
    put(
      `${dir}/inforef.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n  <fileref>\n${fileIds.map((id) => `    <file>\n      <id>${id}</id>\n    </file>`).join('\n')}\n  </fileref>\n  <grade_itemref>\n    <grade_item>\n      <id>${gradeItemId}</id>\n    </grade_item>\n  </grade_itemref>\n</inforef>`,
    );
    put(
      `${dir}/grades.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<activity_gradebook>\n  <grade_items>\n    <grade_item id="${gradeItemId}">\n      <categoryid>$@NULL@$</categoryid>\n      <itemname>${c.xmlEsc(a.name)}</itemname>\n      <itemtype>mod</itemtype>\n      <itemmodule>h5pactivity</itemmodule>\n      <iteminstance>${aid}</iteminstance>\n      <itemnumber>0</itemnumber>\n      <iteminfo>$@NULL@$</iteminfo>\n      <idnumber>$@NULL@$</idnumber>\n      <calculation>$@NULL@$</calculation>\n      <gradetype>1</gradetype>\n      <grademax>${S.grade}.00000</grademax>\n      <grademin>0.00000</grademin>\n      <scaleid>$@NULL@$</scaleid>\n      <outcomeid>$@NULL@$</outcomeid>\n      <gradepass>${S.gradepass}.00000</gradepass>\n      <multfactor>1.00000</multfactor>\n      <plusfactor>0.00000</plusfactor>\n      <aggregationcoef>0.00000</aggregationcoef>\n      <aggregationcoef2>0.00000</aggregationcoef2>\n      <weightoverride>0</weightoverride>\n      <sortorder>${k + 2}</sortorder>\n      <display>0</display>\n      <decimals>$@NULL@$</decimals>\n      <hidden>0</hidden>\n      <locked>0</locked>\n      <locktime>0</locktime>\n      <needsupdate>0</needsupdate>\n      <timecreated>${TS}</timecreated>\n      <timemodified>${TS}</timemodified>\n      <grade_grades>\n      </grade_grades>\n    </grade_item>\n  </grade_items>\n  <grade_letters>\n  </grade_letters>\n</activity_gradebook>`,
    );
    put(`${dir}/roles.xml`, BOIL.roles);
    put(`${dir}/calendar.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>');
    put(`${dir}/grade_history.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>');
    put(`${dir}/competencies.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<course_module_competencies>\n  <competencies>\n  </competencies>\n</course_module_competencies>');
    put(`${dir}/filters.xml`, BOIL.filters);
    put(`${dir}/completion.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<completions>\n  <completionviews>\n  </completionviews>\n</completions>');
    put(`${dir}/comments.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<comments>\n</comments>');
    put(`${dir}/xapistate.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<xapistate>\n</xapistate>');
  });
  filesXml += '</files>';
  put('files.xml', filesXml);

  // ── sections ──
  const sections = [
    { num: 0, name: '', summary: '' },
    { num: 1, name: p.sectionName || 'Capítulo 1 — Video interactivo', summary: '' },
  ];
  for (const s of sections) {
    put(`sections/section_${s.num}/section.xml`, c.sectionXml(s, s.num === secnum ? acts.map((a) => a.mid).join(',') : '', TS));
    put(`sections/section_${s.num}/inforef.xml`, c.inforefXml());
    put(`sections/section_${s.num}/roles.xml`, BOIL.roles);
    put(`sections/section_${s.num}/filters.xml`, BOIL.filters);
    put(`sections/section_${s.num}/contentbank.xml`, BOIL.contentbank);
  }

  // ── course ──
  const t = c.esc(p.courseTitle);
  put('course/course.xml', `<?xml version="1.0" encoding="UTF-8"?>
<course id="1" contextid="1">
  <shortname>${t}</shortname><fullname>${t}</fullname>
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
  <courseformatoptions>
    <courseformatoption><format>topics</format><sectionid>0</sectionid><name>coursedisplay</name><value>0</value></courseformatoption>
    <courseformatoption><format>topics</format><sectionid>0</sectionid><name>hiddensections</name><value>1</value></courseformatoption>
  </courseformatoptions>
</course>`);
  put('course/inforef.xml', c.inforefXml());
  put('course/enrolments.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<enrolments>\n  <enrols>\n  </enrols>\n</enrolments>');
  put('course/roles.xml', BOIL.roles);
  put('course/completiondefaults.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion_defaults>\n</course_completion_defaults>');
  put('course/calendar.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>');
  put('course/competencies.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_competencies>\n  <competencies>\n  </competencies>\n  <user_competencies>\n  </user_competencies>\n</course_competencies>');
  put('course/contentbank.xml', BOIL.contentbank);
  put('course/filters.xml', BOIL.filters);

  // ── root ──
  put('roles.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<roles_definition>\n</roles_definition>');
  put('scales.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<scales_definition>\n</scales_definition>');
  put('outcomes.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<outcomes_definition>\n</outcomes_definition>');
  put('completion.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion>\n</course_completion>');
  put('badges.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<badges>\n</badges>');
  put('users.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<users>\n</users>');
  put('questions.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<question_categories>\n</question_categories>');
  put('grade_history.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>');
  put('groups.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<groups>\n  <groupcustomfields>\n  </groupcustomfields>\n  <groupings>\n    <groupingcustomfields>\n    </groupingcustomfields>\n  </groupings>\n</groups>');
  put('gradebook.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<gradebook>\n  <attributes>\n  </attributes>\n  <grade_categories>\n    <grade_category id="1">\n      <parent>$@NULL@$</parent><depth>1</depth><path>/1/</path><fullname>?</fullname>\n      <aggregation>13</aggregation><keephigh>0</keephigh><droplow>0</droplow>\n      <aggregateonlygraded>1</aggregateonlygraded><aggregateoutcomes>0</aggregateoutcomes>\n      <timecreated>${TS}</timecreated><timemodified>${TS}</timemodified><hidden>0</hidden>\n    </grade_category>\n  </grade_categories>\n  <grade_items>\n    <grade_item id="1">\n      <categoryid>$@NULL@$</categoryid><itemname>$@NULL@$</itemname><itemtype>course</itemtype>\n      <itemmodule>$@NULL@$</itemmodule><iteminstance>1</iteminstance><itemnumber>$@NULL@$</itemnumber>\n      <iteminfo>$@NULL@$</iteminfo><idnumber>$@NULL@$</idnumber><calculation>$@NULL@$</calculation>\n      <gradetype>1</gradetype><grademax>100.00000</grademax><grademin>0.00000</grademin>\n      <scaleid>$@NULL@$</scaleid><outcomeid>$@NULL@$</outcomeid><gradepass>0.00000</gradepass>\n      <multfactor>1.00000</multfactor><plusfactor>0.00000</plusfactor>\n      <aggregationcoef>0.00000</aggregationcoef><aggregationcoef2>0.00000</aggregationcoef2>\n      <weightoverride>0</weightoverride><sortorder>1</sortorder><display>0</display>\n      <decimals>$@NULL@$</decimals><hidden>0</hidden><locked>0</locked><locktime>0</locktime>\n      <needsupdate>0</needsupdate><timecreated>${TS}</timecreated><timemodified>${TS}</timemodified>\n      <grade_grades></grade_grades>\n    </grade_item>\n  </grade_items>\n  <grade_letters></grade_letters>\n  <grade_settings></grade_settings>\n</gradebook>`);

  // ── moodle_backup.xml ──
  let sett = '';
  const root = {
    filename: 'cursia-v21-r8-video.mbz', imscc11: '0', users: '0', anonymize: '0', role_assignments: '0',
    activities: '1', blocks: '0', files: '1', filters: '1', comments: '0', badges: '0',
    calendarevents: '1', userscompletion: '0', logs: '0', grade_histories: '0',
    questionbank: '1', groups: '0', competencies: '0', customfield: '0',
    contentbankcontent: '0', xapistate: '0', legacyfiles: '1',
  };
  for (const [k, v] of Object.entries(root)) sett += `    <setting>\n      <level>root</level>\n      <name>${k}</name>\n      <value>${v}</value>\n    </setting>\n`;
  for (const s of sections) {
    for (const suf of ['included', 'userinfo']) {
      sett += `    <setting>\n      <level>section</level>\n      <section>section_${s.num}</section>\n      <name>section_${s.num}_${suf}</name>\n      <value>${suf === 'included' ? 1 : 0}</value>\n    </setting>\n`;
    }
  }
  for (const a of acts) {
    const pre = `h5pactivity_${a.mid}`;
    for (const suf of ['included', 'userinfo']) {
      sett += `    <setting>\n      <level>activity</level>\n      <activity>${pre}</activity>\n      <name>${pre}_${suf}</name>\n      <value>${suf === 'included' ? 1 : 0}</value>\n    </setting>\n`;
    }
  }
  put('moodle_backup.xml', `<?xml version="1.0" encoding="UTF-8"?>
<moodle_backup>
<information>
  <name>cursia-v21-r8-video.mbz</name>
  <moodle_version>${MV.mv}</moodle_version>
  <moodle_release>${MV.mr}</moodle_release>
  <backup_version>${MV.bv}</backup_version>
  <backup_release>${MV.br}</backup_release>
  <backup_date>${TS}</backup_date>
  <mnet_remoteusers>0</mnet_remoteusers>
  <include_files>1</include_files>
  <include_file_references_to_external_content>0</include_file_references_to_external_content>
  <original_wwwroot>https://cursia.invalid</original_wwwroot>
  <original_site_identifier_hash>00000000000000000000000000000000</original_site_identifier_hash>
  <original_course_id>1</original_course_id>
  <original_course_fullname>${t}</original_course_fullname>
  <original_course_shortname>${t}</original_course_shortname>
  <original_course_format>topics</original_course_format>
  <original_course_startdate>${TS}</original_course_startdate>
  <original_course_enddate>0</original_course_enddate>
  <original_course_contextid>1</original_course_contextid>
  <original_system_contextid>1</original_system_contextid>
  <details>
    <detail backup_id="cursiav21r8${TS}">
      <type>course</type><format>moodle2</format><interactive>1</interactive>
      <mode>70</mode><execution>2</execution><executiontime>0</executiontime>
    </detail>
  </details>
  <contents>
    <activities>
${acts.map((a) => `      <activity>\n        <moduleid>${a.mid}</moduleid>\n        <sectionid>${secnum}</sectionid>\n        <modulename>h5pactivity</modulename>\n        <title>${c.esc(a.name)}</title>\n        <directory>activities/h5pactivity_${a.mid}</directory>\n        <insubsection></insubsection>\n      </activity>`).join('\n')}
    </activities>
    <sections>
${sections.map((s) => `      <section>\n        <sectionid>${s.num}</sectionid>\n        <title>${c.esc(s.name || String(s.num))}</title>\n        <directory>sections/section_${s.num}</directory>\n        <parentcmid></parentcmid>\n        <modname></modname>\n      </section>`).join('\n')}
    </sections>
    <course>
      <courseid>1</courseid>
      <title>${t}</title>
      <directory>course</directory>
    </course>
  </contents>
  <settings>
${sett}  </settings>
</information>
</moodle_backup>`);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** Caso del video (R8): una actividad con intro inline y el .h5p también en el filearea intro. */
function buildMiniVideoMbz(p) {
  return buildMiniH5pMbz({
    courseTitle: p.courseTitle,
    activities: [{ mid: p.mid, name: p.activityName, packageFilename: p.packageFilename, h5p: p.h5p, introHtml: p.introHtml, inlineIntroFile: true }],
  });
}

module.exports = { buildMiniH5pMbz, buildMiniVideoMbz, MINI_MBZ_TS: TS };
