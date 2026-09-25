/**
 * dynamic-mbz-builder.ts
 *
 * Fase 5B.1 — construye un .mbz de Moodle dinámico (N módulos, M capítulos
 * cada uno) a partir de un `PackagingPlan` (puro, ya calculado por B1) y los
 * contenidos ya resueltos de artifacts de Fase 5A (`DynamicPackageContents`).
 *
 * Principios (spec `2026-09-25-dynamic-course-structure-fase5b-packaging-design.md`):
 * - Sin I/O: todo el contenido entra por parámetro (`input.contents`).
 * - Legacy intocable: `mbz-builder.service.ts` y `package-worker.ts` no se
 *   tocan. Las piezas genéricas reutilizables (sha1, escapes, XML boilerplate
 *   común, parser GIFT) están copiadas en `mbz-common.ts` con referencia a la
 *   línea de origen. Las piezas específicas de SCORM/quiz que legacy no
 *   exporta se copian aquí mismo (marcadas con el file:line de origen).
 * - Sin examen final, sin LLM: todo texto de packaging es plantilla.
 * - Falla fuerte: si el plan referencia contenido que no está en `contents`,
 *   se lanza un Error listando exactamente qué falta — nunca un placeholder
 *   "⚠️ Pendiente".
 * - Numeración: los números (chapterNumber, moduleNumber, sectionNum) salen
 *   SOLO del PackagingPlan. La identidad (para el join con `contents`) es
 *   siempre el UUID (chapterId/moduleId).
 */

import * as JSZip from 'jszip';
import {
  resolveMoodleVersion,
  sha1Buf,
  textBytes,
  esc,
  xmlEsc,
  safeActivityName,
  moduleXml,
  labelXmlWithCtx,
  inforefXml,
  inforefXmlWithFiles,
  gradesXml,
  forumXml,
  sectionXml,
  writeActFiles,
  parseGIFT,
  SectionMeta,
} from './mbz-common';
import {
  BuildDynamicMbzInput,
  PackagingChapterPlan,
  PackagingModulePlan,
  PackagingPlan,
} from '../modules/dynamic-packaging/packaging-types';

// ─── Palette ────────────────────────────────────────────────────────────────

interface ModuleColor { main: string; accent: string }
interface Palette { dark: string; accent: string; modules: ModuleColor[] }

const DEFAULT_PALETTE: Palette = {
  dark: '0A1A28',
  accent: 'E8692A',
  modules: [
    { main: '2563EB', accent: '93C5FD' },
    { main: '16A085', accent: '2DD4BF' },
    { main: '7D3C98', accent: 'C084FC' },
    { main: 'C0392B', accent: 'F1948A' },
    { main: 'B7950B', accent: 'F7DC6F' },
  ],
};

function moduleColor(palette: Palette, colorIndex: number): ModuleColor {
  const mods = palette.modules.length ? palette.modules : DEFAULT_PALETTE.modules;
  return mods[((colorIndex % mods.length) + mods.length) % mods.length];
}

// ─── Small safe Markdown → HTML converter (no library dependency) ──────────
// Suficiente para el contenido determinístico de `dynamic_content_md`
// (encabezados, listas, negrita/cursiva, párrafos). No pretende soportar
// Markdown arbitrario — si el content-worker empieza a emitir tablas u otras
// construcciones, este conversor deberá extenderse.

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMd(s: string): string {
  let t = escapeHtmlText(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  return t;
}

function mdToHtmlBasic(md: string): string {
  const lines = (md ?? '').split(/\r?\n/);
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>\n'; inList = false; } };
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.*)/);
    const h2 = line.match(/^##\s+(.*)/);
    const h1 = line.match(/^#\s+(.*)/);
    const li = line.match(/^[-*]\s+(.*)/);
    if (h1) { closeList(); html += `<h1>${inlineMd(h1[1])}</h1>\n`; continue; }
    if (h2) { closeList(); html += `<h2>${inlineMd(h2[1])}</h2>\n`; continue; }
    if (h3) { closeList(); html += `<h3>${inlineMd(h3[1])}</h3>\n`; continue; }
    if (li) { if (!inList) { html += '<ul>\n'; inList = true; } html += `<li>${inlineMd(li[1])}</li>\n`; continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    html += `<p>${inlineMd(line)}</p>\n`;
  }
  closeList();
  return html;
}

// ─── Deterministic templates (sin LLM — ver spec §5 "Determinísticos") ─────

function welcomeLabelHtml(plan: PackagingPlan): string {
  const modItems = plan.modules
    .map((m) => `<li>Módulo ${m.moduleNumber}: ${esc(m.title)}</li>`)
    .join('\n');
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;">`
    + `<h1>${esc(plan.course.title)}</h1>`
    + (plan.course.summary ? `<p>${esc(plan.course.summary)}</p>` : '')
    + `<h2>Módulos del curso</h2>`
    + `<ul>${modItems}</ul>`
    + `</div>`;
}

function routeLabelHtml(plan: PackagingPlan): string {
  const blocks = plan.modules.map((m) => {
    const items = m.chapters
      .map((c) => `<li>Capítulo ${c.chapterNumber}: ${esc(c.title)}</li>`)
      .join('\n');
    return `<h3>Módulo ${m.moduleNumber} — ${esc(m.title)}</h3><ol>${items}</ol>`;
  }).join('\n');
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;">`
    + `<h2>🗺️ Ruta de aprendizaje</h2>`
    + blocks
    + `</div>`;
}

function libroCardHtml(libroMid: number): string {
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;">`
    + `<h3>📘 Libro Guía del curso</h3>`
    + `<p>Consulta el libro guía completo del curso, con todos los capítulos en un solo documento.</p>`
    + `<a href="$@RESOURCEVIEWBYID*${libroMid}@$">Abrir Libro Guía</a>`
    + `</div>`;
}

function chapterIntroHtml(ch: PackagingChapterPlan, color: ModuleColor, hasVideo: boolean): string {
  return `<div style="border-left:4px solid #${color.main};padding:16px 20px;font-family:'Segoe UI',Arial,sans-serif;">`
    + `<span style="text-transform:uppercase;font-size:11px;font-weight:700;color:#${color.main};">Capítulo ${ch.chapterNumber}</span>`
    + `<h2 style="margin:6px 0;">${esc(ch.title)}</h2>`
    + (ch.objective ? `<p>${esc(ch.objective)}</p>` : '')
    + (hasVideo ? `<p>🎬 Este capítulo incluye un video que se abre en una pestaña externa.</p>` : '')
    + `</div>`;
}

function ctaLabelHtml(ch: PackagingChapterPlan, color: ModuleColor, scormMid: number): string {
  return `<div style="background:#${color.main};padding:20px;text-align:center;border-radius:12px;font-family:'Segoe UI',Arial,sans-serif;color:#fff;">`
    + `<p style="margin:0 0 10px;font-weight:700;">¿Listo para poner a prueba lo aprendido?</p>`
    + `<a href="$@SCORMVIEWBYID*${scormMid}@$" style="color:#${color.main};background:#fff;padding:10px 24px;border-radius:24px;text-decoration:none;font-weight:700;">🎮 Practicar ahora — Cap ${ch.chapterNumber}</a>`
    + `</div>`;
}

function videoUrlIntroHtml(ch: PackagingChapterPlan): string {
  return `<p>Video del capítulo ${ch.chapterNumber} — ${esc(ch.title)}. Este video se abre en una pestaña externa (no está embebido en el curso).</p>`;
}

function scormIntroHtml(ch: PackagingChapterPlan): string {
  return `<p>Actividad interactiva del capítulo ${ch.chapterNumber} — ${esc(ch.title)}</p>`;
}

function examDescriptionHtml(mod: PackagingModulePlan, questionCount: number): string {
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;">`
    + `<h3>Evaluación del módulo ${mod.moduleNumber} — ${esc(mod.title)}</h3>`
    + `<p>Esta evaluación contiene ${questionCount} pregunta(s).</p>`
    + `</div>`;
}

function compileLibroHtml(courseTitle: string, orderedChapters: PackagingChapterPlan[], contentMd: Map<string, string>): string {
  const toc = orderedChapters
    .map((c) => `<li><a href="#cap-${c.chapterNumber}">Capítulo ${c.chapterNumber}: ${esc(c.title)}</a></li>`)
    .join('\n');
  const body = orderedChapters.map((c) => {
    const md = contentMd.get(c.chapterId) ?? '';
    return `<section id="cap-${c.chapterNumber}"><h2>Capítulo ${c.chapterNumber} — ${esc(c.title)}</h2>\n${mdToHtmlBasic(md)}</section>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${esc(courseTitle)} — Libro Guía</title></head>
<body>
<div class="cc-libro-cover"><h1>${esc(courseTitle)}</h1><p>Libro Guía del curso</p></div>
<div class="cc-libro-toc"><h2>Índice</h2><ul>${toc}</ul></div>
${body}
</body>
</html>`;
}

// ─── SCORM/quiz XML — no exportados por el legacy; copiados aquí con el
// file:line de origen (mbz-builder.service.ts, revisión c1733ae y anteriores).
// Sin el trichotomy <=3/<=6: el color/sección ya vienen resueltos del plan.

// mbz-builder.service.ts:949 (módulo con completion=2, específico de scorm/quiz)
function activityModuleXmlCompletion2(mid: number, modname: 'scorm' | 'quiz', secnum: number, ts: number, bv: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<module id="${mid}" version="${bv}">\n  <modulename>${modname}</modulename>\n  <sectionid>${secnum}</sectionid>\n  <sectionnumber>${secnum}</sectionnumber>\n  <idnumber></idnumber>\n  <added>${ts}</added>\n  <score>0</score>\n  <indent>0</indent>\n  <visible>1</visible>\n  <visibleoncoursepage>1</visibleoncoursepage>\n  <visibleold>1</visibleold>\n  <groupmode>0</groupmode>\n  <groupingid>0</groupingid>\n  <completion>2</completion>\n  <completiongradeitemnumber>0</completiongradeitemnumber>\n  <completionpassgrade>0</completionpassgrade>\n  <completionview>0</completionview>\n  <completionexpected>0</completionexpected>\n  <availability>$@NULL@$</availability>\n  <showdescription>1</showdescription>\n  <downloadcontent>1</downloadcontent>\n  <lang></lang>\n  <tags>\n  </tags>\n</module>`;
}

// mbz-builder.service.ts:869-947 (scorm.xml, parametrizado)
function scormActivityXml(p: {
  aid: number; mid: number; ctx: number; actName: string; scormZipName: string;
  introHtml: string; zipHash: string; scoOrg: number; scoItem: number; scoD1: number; scoD2: number;
  capLabel: string; ts: number;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="scorm" contextid="${p.ctx}">
  <scorm id="${p.aid}">
    <name>${xmlEsc(p.actName)}</name>
    <scormtype>local</scormtype>
    <reference>${xmlEsc(p.scormZipName)}</reference>
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
        <manifest>cap${p.capLabel}_juego</manifest>
        <organization></organization>
        <parent>/</parent>
        <identifier>cap${p.capLabel}_org</identifier>
        <launch></launch>
        <scormtype></scormtype>
        <title>${xmlEsc(p.actName)}</title>
        <sortorder>1</sortorder>
        <sco_datas></sco_datas>
        <seq_ruleconds></seq_ruleconds>
        <seq_rolluprules></seq_rolluprules>
        <seq_objectives></seq_objectives>
        <sco_tracks></sco_tracks>
      </sco>
      <sco id="${p.scoItem}">
        <manifest>cap${p.capLabel}_juego</manifest>
        <organization>cap${p.capLabel}_org</organization>
        <parent>cap${p.capLabel}_org</parent>
        <identifier>item_1</identifier>
        <launch>index.html</launch>
        <scormtype>sco</scormtype>
        <title>${xmlEsc(p.actName)}</title>
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
}

// mbz-builder.service.ts:951 (grade_item completo, parametrizado)
function activityGradeItemXml(p: { gradeItemId: number; itemName: string; itemModule: 'scorm' | 'quiz'; aid: number; ts: number; grademax?: string }): string {
  const grademax = p.grademax ?? '100.00000';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<activity_gradebook>\n  <grade_items>\n    <grade_item id="${p.gradeItemId}">\n      <categoryid>$@NULL@$</categoryid>\n      <itemname>${xmlEsc(p.itemName)}</itemname>\n      <itemtype>mod</itemtype>\n      <itemmodule>${p.itemModule}</itemmodule>\n      <iteminstance>${p.aid}</iteminstance>\n      <itemnumber>0</itemnumber>\n      <iteminfo>$@NULL@$</iteminfo>\n      <idnumber></idnumber>\n      <calculation>$@NULL@$</calculation>\n      <gradetype>1</gradetype>\n      <grademax>${grademax}</grademax>\n      <grademin>0.00000</grademin>\n      <scaleid>$@NULL@$</scaleid>\n      <outcomeid>$@NULL@$</outcomeid>\n      <gradepass>0.00000</gradepass>\n      <multfactor>1.00000</multfactor>\n      <plusfactor>0.00000</plusfactor>\n      <aggregationcoef>0.00000</aggregationcoef>\n      <aggregationcoef2>0.00000</aggregationcoef2>\n      <weightoverride>0</weightoverride>\n      <sortorder>1</sortorder>\n      <display>0</display>\n      <decimals>$@NULL@$</decimals>\n      <hidden>0</hidden>\n      <locked>0</locked>\n      <locktime>0</locktime>\n      <needsupdate>0</needsupdate>\n      <timecreated>${p.ts}</timecreated>\n      <timemodified>${p.ts}</timemodified>\n      <grade_grades>\n      </grade_grades>\n    </grade_item>\n  </grade_items>\n  <grade_letters>\n  </grade_letters>\n</activity_gradebook>`;
}

function inforefFilesAndGrade(fileIds: number[], gradeItemId: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n  <fileref>\n${fileIds.map((id) => `    <file><id>${id}</id></file>`).join('\n')}\n  </fileref>\n  <grade_itemref>\n    <grade_item><id>${gradeItemId}</id></grade_item>\n  </grade_itemref>\n</inforef>`;
}

const ACTIVITY_BOILERPLATE_ROLES = '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>';
const ACTIVITY_BOILERPLATE_CALENDAR = '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>';
const ACTIVITY_BOILERPLATE_GRADE_HISTORY = '<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>';
const ACTIVITY_BOILERPLATE_COMPETENCIES = '<?xml version="1.0" encoding="UTF-8"?>\n<course_module_competencies>\n  <competencies>\n  </competencies>\n</course_module_competencies>';
const ACTIVITY_BOILERPLATE_FILTERS = '<?xml version="1.0" encoding="UTF-8"?>\n<filters>\n  <filter_actives>\n  </filter_actives>\n  <filter_configs>\n  </filter_configs>\n</filters>';

// mbz-builder.service.ts:1051-1078 (quiz.xml), parametrizado
function quizActivityXml(p: {
  aid: number; mid: number; ctx: number; examName: string; introHtml: string;
  questionInstancesXml: string; ts: number;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="quiz" contextid="${p.ctx}">
  <quiz id="${p.aid}">
    <name>${xmlEsc(p.examName)}</name><intro>${xmlEsc(p.introHtml)}</intro><introformat>1</introformat>
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
    <sumgrades>100.00000</sumgrades><grade>100.00000</grade>
    <timecreated>${p.ts}</timecreated><timemodified>${p.ts}</timemodified>
    <password></password><subnet></subnet><browsersecurity>-</browsersecurity>
    <delay1>0</delay1><delay2>0</delay2><showuserpicture>0</showuserpicture><showblocks>0</showblocks>
    <completionattemptsexhausted>0</completionattemptsexhausted><completionminattempts>1</completionminattempts>
    <allowofflineattempts>0</allowofflineattempts>
    <subplugin_quizaccess_seb_quiz></subplugin_quizaccess_seb_quiz>
    <quiz_grade_items></quiz_grade_items>
    <question_instances>\n${p.questionInstancesXml}    </question_instances>
    <sections><section id="${p.aid}"><firstslot>1</firstslot><heading></heading><shufflequestions>0</shufflequestions></section></sections>
    <feedbacks><feedback id="${300000 + p.mid}"><feedbacktext></feedbacktext><feedbacktextformat>1</feedbacktextformat><mingrade>0.00000</mingrade><maxgrade>101.00000</maxgrade></feedback></feedbacks>
    <overrides></overrides><grades></grades><attempts></attempts>
  </quiz>
</activity>`;
}

function inforefQuiz(gradeItemId: number, catTopId: number, catDefaultId: number, catId: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n  <grade_itemref>\n    <grade_item><id>${gradeItemId}</id></grade_item>\n  </grade_itemref>\n  <question_categoryref>\n    <question_category><id>${catTopId}</id></question_category>\n    <question_category><id>${catDefaultId}</id></question_category>\n    <question_category><id>${catId}</id></question_category>\n  </question_categoryref>\n</inforef>`;
}

// ─── url activity (nuevo, no existe en legacy — video externo, spec §6 opción A) ──

function urlActivityXml(p: { aid: number; mid: number; ctx: number; name: string; introHtml: string; externalUrl: string; ts: number }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="url" contextid="${p.ctx}">
  <url id="${p.aid}">
    <name>${xmlEsc(p.name)}</name>
    <intro>${xmlEsc(p.introHtml)}</intro>
    <introformat>1</introformat>
    <externalurl>${xmlEsc(p.externalUrl)}</externalurl>
    <display>0</display>
    <displayoptions>a:0:{}</displayoptions>
    <parameters>a:0:{}</parameters>
    <timemodified>${p.ts}</timemodified>
  </url>
</activity>`;
}

// ─── resource (Libro Guía) — mbz-builder.service.ts:1332 ───────────────────

function libroResourceXml(aid: number, mid: number, ctx: number, name: string, ts: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<activity id="${aid}" moduleid="${mid}" modulename="resource" contextid="${ctx}">\n  <resource id="${aid}">\n    <name>${xmlEsc(name)}</name>\n    <intro></intro>\n    <introformat>1</introformat>\n    <tobemigrated>0</tobemigrated>\n    <legacyfiles>0</legacyfiles>\n    <legacyfileslast>$@NULL@$</legacyfileslast>\n    <display>5</display>\n    <displayoptions>a:1:{s:10:"printintro";s:1:"0";}</displayoptions>\n    <filterfiles>0</filterfiles>\n    <revision>1</revision>\n    <timemodified>${ts}</timemodified>\n  </resource>\n</activity>`;
}

const SECTION_BOILERPLATE_ROLES = ACTIVITY_BOILERPLATE_ROLES;
const SECTION_BOILERPLATE_FILTERS = ACTIVITY_BOILERPLATE_FILTERS;
const SECTION_BOILERPLATE_CONTENTBANK = '<?xml version="1.0" encoding="UTF-8"?>\n<contents>\n</contents>';

// ─── Section derivation from the plan (spec §3) ────────────────────────────

function deriveSectionDefs(plan: PackagingPlan): SectionMeta[] {
  return plan.sections.map((s) => {
    if (s.kind === 'welcome') {
      return { num: 0, name: s.title, summary: 'Bienvenida al curso, resumen y módulos.' };
    }
    if (s.kind === 'route_and_book') {
      return { num: 1, name: s.title, summary: 'Ruta de aprendizaje y Libro Guía del curso.' };
    }
    const mod = plan.modules.find((m) => m.moduleId === s.moduleId);
    const chapterRange = mod && mod.chapters.length
      ? (mod.chapters.length === 1
        ? `Capítulo ${mod.chapters[0].chapterNumber}`
        : `Capítulos ${mod.chapters[0].chapterNumber} a ${mod.chapters[mod.chapters.length - 1].chapterNumber}`)
      : 'Sin capítulos';
    const objectivePart = mod?.objective ? ` ${mod.objective}` : '';
    const examPart = mod?.examItemKey ? ' Incluye evaluación de módulo.' : '';
    return { num: s.sectionNum, name: s.title, summary: `${chapterRange}.${objectivePart}${examPart}` };
  });
}

// ─── Main entry point ───────────────────────────────────────────────────────

export async function buildDynamicMbz(input: BuildDynamicMbzInput): Promise<Buffer> {
  const { plan, contents } = input;
  const palette: Palette = input.palette
    ? { dark: input.palette.dark, accent: input.palette.accent, modules: input.palette.modules }
    : DEFAULT_PALETTE;
  const MV = resolveMoodleVersion(input.moodleVersion);
  const ts = Math.floor(Date.now() / 1000);
  const zip = new JSZip();

  // ── Fail fuerte: validar que `contents` tiene TODO lo que el plan referencia ──
  const missing: string[] = [];
  for (const mod of plan.modules) {
    for (const ch of mod.chapters) {
      if (!contents.contentMd.has(ch.chapterId)) missing.push(ch.contentItemKey);
      if (!contents.scorm.has(ch.chapterId)) missing.push(ch.scormItemKey);
      if (ch.videoItemKey && !contents.videos.has(ch.chapterId)) missing.push(ch.videoItemKey);
    }
    if (mod.examItemKey && !contents.examGift.has(mod.moduleId)) missing.push(mod.examItemKey);
  }
  if (missing.length) {
    throw new Error(`No se puede empaquetar: faltan ${missing.length} contenido(s) del Manifest: ${missing.join(', ')}`);
  }

  // ── Counters (idénticos rangos a mbz-builder.service.ts:109-110,713-717) ──
  let ctxId = 2;
  let fileId = 10000;
  let actId = 1;
  let modId = 953;
  let scoIdCounter = 50000;
  let scoDataCounter = 60000;

  const filesXmlEntries: Array<Record<string, any>> = [];
  const questionsXmlEntries: Array<Record<string, any>> = [];
  const mbzActivities: Array<{ mid: number; secnum: number; modname: string; title: string; dir: string }> = [];
  const actSettings: Array<{ mid: number; modname: string; title: string }> = [];
  const secActs = new Map<number, number[]>();
  const ctaMap: Record<number, string> = {};

  function pushAct(secnum: number, mid: number): void {
    if (!secActs.has(secnum)) secActs.set(secnum, []);
    secActs.get(secnum)!.push(mid);
  }

  /**
   * Saneamiento final de tokens $@...VIEWBYID*N@$ contra ctaMap — defensa en
   * profundidad idéntica a mbz-builder.service.ts:1409-1418, extendida con
   * 'URL' para la actividad de video externo. Todo el texto de 5B.1 es
   * plantilla determinística (nunca LLM), así que en la práctica esta pasada
   * no debería reescribir nada — pero se mantiene como red de seguridad.
   */
  function sanitizeTokens(html: string): string {
    const tokenModname: Record<string, string> = { SCORM: 'scorm', QUIZ: 'quiz', RESOURCE: 'resource', PAGE: 'page', URL: 'url' };
    return html.replace(/\$@(SCORM|QUIZ|RESOURCE|PAGE|URL)VIEWBYID\*(\d+)@\$/g, (match, kind: string, idStr: string) => {
      const mid = parseInt(idStr, 10);
      if (ctaMap[mid] === tokenModname[kind]) return match;
      return '#';
    });
  }

  function addLabel(secnum: number, name: string, rawContent: string): number {
    const aid = actId++;
    const mid = modId++;
    const ctx = ctxId++;
    ctaMap[mid] = 'label';
    const content = sanitizeTokens(rawContent);
    const dir = `activities/label_${mid}`;
    zip.file(`${dir}/label.xml`, labelXmlWithCtx(aid, mid, ctx, name, content, ts));
    zip.file(`${dir}/module.xml`, moduleXml(mid, 'label', secnum, ts, MV.bv));
    zip.file(`${dir}/inforef.xml`, inforefXml());
    zip.file(`${dir}/grades.xml`, gradesXml(aid));
    writeActFiles(zip, dir);
    mbzActivities.push({ mid, secnum, modname: 'label', title: name, dir });
    actSettings.push({ mid, modname: 'label', title: name });
    pushAct(secnum, mid);
    return mid;
  }

  // ── Forum (sección 0, primera actividad — igual que legacy) ────────────
  {
    const forumAid = actId++;
    const forumMid = modId++;
    const forumCtx = ctxId++;
    const forumDir = `activities/forum_${forumMid}`;
    const forumName = '📢 Avisos del Curso';
    zip.file(`${forumDir}/forum.xml`, forumXml(forumAid, forumMid, forumCtx, forumName, ts));
    zip.file(`${forumDir}/module.xml`, moduleXml(forumMid, 'forum', 0, ts, MV.bv));
    zip.file(`${forumDir}/inforef.xml`, inforefXml());
    zip.file(`${forumDir}/grades.xml`, gradesXml(forumAid));
    zip.file(`${forumDir}/posts.xml`, '<?xml version="1.0" encoding="UTF-8"?><posts></posts>');
    zip.file(`${forumDir}/subscribers.xml`, '<?xml version="1.0" encoding="UTF-8"?><subscribers></subscribers>');
    zip.file(`${forumDir}/discussions.xml`, '<?xml version="1.0" encoding="UTF-8"?><discussions></discussions>');
    writeActFiles(zip, forumDir);
    ctaMap[forumMid] = 'forum';
    mbzActivities.push({ mid: forumMid, secnum: 0, modname: 'forum', title: forumName, dir: forumDir });
    actSettings.push({ mid: forumMid, modname: 'forum', title: forumName });
    pushAct(0, forumMid);
  }

  // ── Bienvenida (sección 0) ──────────────────────────────────────────────
  addLabel(0, '🏠 Bienvenida al Curso', welcomeLabelHtml(plan));

  // ── Ruta de aprendizaje (sección 1) ─────────────────────────────────────
  addLabel(1, '🗺️ Ruta de Aprendizaje', routeLabelHtml(plan));

  // ── Libro Guía: resource primero (para conocer libroMid de una), luego la
  // tarjeta promocional que enlaza a él directamente (sin necesidad de marker
  // + rewrite, ya que el orden de construcción lo permite). ──
  const allChaptersInOrder = plan.modules
    .flatMap((m) => m.chapters)
    .slice()
    .sort((a, b) => a.chapterNumber - b.chapterNumber);

  const libroHtml = compileLibroHtml(plan.course.title, allChaptersInOrder, contents.contentMd);
  if (!/<\/html>\s*$/i.test(libroHtml.trim())) {
    // Guard defensivo — mismo patrón que mbz-builder.service.ts:1312-1316,
    // aunque en 5B.1 el compilador es determinístico y siempre debería cerrar.
    throw new Error('Libro Guía compilado sin cierre </html> — se aborta el empaquetado en vez de incluir HTML roto');
  }

  let libroMid: number;
  {
    const libroAid = actId++;
    libroMid = modId++;
    const libroCtx = ctxId++;
    ctaMap[libroMid] = 'resource';
    const libroHash = sha1Buf(libroHtml);
    const libroFid = fileId++;
    zip.file(`files/${libroHash.substring(0, 2)}/${libroHash}`, libroHtml);
    filesXmlEntries.push({ id: libroFid, hash: libroHash, ctx: libroCtx, comp: 'mod_resource', area: 'content', item: 0, path: '/', name: 'libro_guia_completo.html', size: textBytes(libroHtml), mime: 'text/html' });

    const libroDir = `activities/resource_${libroMid}`;
    zip.file(`${libroDir}/resource.xml`, libroResourceXml(libroAid, libroMid, libroCtx, '📘 Libro Guía', ts));
    zip.file(`${libroDir}/module.xml`, moduleXml(libroMid, 'resource', 1, ts, MV.bv));
    zip.file(`${libroDir}/inforef.xml`, inforefXmlWithFiles([libroFid]));
    zip.file(`${libroDir}/grades.xml`, gradesXml(libroAid));
    writeActFiles(zip, libroDir);
    mbzActivities.push({ mid: libroMid, secnum: 1, modname: 'resource', title: '📘 Libro Guía', dir: libroDir });
    actSettings.push({ mid: libroMid, modname: 'resource', title: '📘 Libro Guía' });
    pushAct(1, libroMid);
  }

  addLabel(1, '📘 Tarjeta Libro Guía', libroCardHtml(libroMid));

  // ── Por módulo ───────────────────────────────────────────────────────────
  for (const mod of plan.modules) {
    const color = moduleColor(palette, mod.colorIndex);

    for (const ch of mod.chapters) {
      // Se asignan los ids de TODAS las actividades del capítulo por adelantado,
      // así el CTA puede referenciar el mid real del scorm sin necesitar un
      // marker + pasada de reescritura (a diferencia del legacy, cuyo orden de
      // construcción por nombre de archivo lo obligaba).
      const introAid = actId++; const introMid = modId++; const introCtx = ctxId++;
      let videoAid = 0, videoMid = 0, videoCtx = 0;
      if (ch.videoItemKey) { videoAid = actId++; videoMid = modId++; videoCtx = ctxId++; }
      const ctaAid = actId++; const ctaMid = modId++; const ctaCtx = ctxId++;
      const scormAid = actId++; const scormMid = modId++; const scormCtx = ctxId++;

      ctaMap[introMid] = 'label';
      if (ch.videoItemKey) ctaMap[videoMid] = 'url';
      ctaMap[ctaMid] = 'label';
      ctaMap[scormMid] = 'scorm';

      // 1. Intro
      const introName = safeActivityName(`📖 Capítulo ${ch.chapterNumber} — ${ch.title}`);
      const introContent = sanitizeTokens(chapterIntroHtml(ch, color, !!ch.videoItemKey));
      const introDir = `activities/label_${introMid}`;
      zip.file(`${introDir}/label.xml`, labelXmlWithCtx(introAid, introMid, introCtx, introName, introContent, ts));
      zip.file(`${introDir}/module.xml`, moduleXml(introMid, 'label', mod.sectionNum, ts, MV.bv));
      zip.file(`${introDir}/inforef.xml`, inforefXml());
      zip.file(`${introDir}/grades.xml`, gradesXml(introAid));
      writeActFiles(zip, introDir);
      mbzActivities.push({ mid: introMid, secnum: mod.sectionNum, modname: 'label', title: introName, dir: introDir });
      actSettings.push({ mid: introMid, modname: 'label', title: introName });
      pushAct(mod.sectionNum, introMid);

      // 2. Video (url externa) — solo si el Manifest lo incluye
      if (ch.videoItemKey) {
        const video = contents.videos.get(ch.chapterId)!;
        const videoName = safeActivityName(`🎬 Video del capítulo ${ch.chapterNumber} — ${ch.title}`);
        const videoDir = `activities/url_${videoMid}`;
        const videoIntro = sanitizeTokens(videoUrlIntroHtml(ch));
        zip.file(`${videoDir}/url.xml`, urlActivityXml({ aid: videoAid, mid: videoMid, ctx: videoCtx, name: videoName, introHtml: videoIntro, externalUrl: video.url, ts }));
        zip.file(`${videoDir}/module.xml`, moduleXml(videoMid, 'url', mod.sectionNum, ts, MV.bv));
        zip.file(`${videoDir}/inforef.xml`, inforefXml());
        zip.file(`${videoDir}/grades.xml`, gradesXml(videoAid));
        writeActFiles(zip, videoDir);
        mbzActivities.push({ mid: videoMid, secnum: mod.sectionNum, modname: 'url', title: videoName, dir: videoDir });
        actSettings.push({ mid: videoMid, modname: 'url', title: videoName });
        pushAct(mod.sectionNum, videoMid);
      }

      // 3. CTA — enlaza directo al mid del scorm (ya asignado arriba)
      const ctaName = `🎯 Practicar — Cap ${ch.chapterNumber}`;
      const ctaContent = sanitizeTokens(ctaLabelHtml(ch, color, scormMid));
      const ctaDir = `activities/label_${ctaMid}`;
      zip.file(`${ctaDir}/label.xml`, labelXmlWithCtx(ctaAid, ctaMid, ctaCtx, ctaName, ctaContent, ts));
      zip.file(`${ctaDir}/module.xml`, moduleXml(ctaMid, 'label', mod.sectionNum, ts, MV.bv));
      zip.file(`${ctaDir}/inforef.xml`, inforefXml());
      zip.file(`${ctaDir}/grades.xml`, gradesXml(ctaAid));
      writeActFiles(zip, ctaDir);
      mbzActivities.push({ mid: ctaMid, secnum: mod.sectionNum, modname: 'label', title: ctaName, dir: ctaDir });
      actSettings.push({ mid: ctaMid, modname: 'label', title: ctaName });
      pushAct(mod.sectionNum, ctaMid);

      // 4. SCORM
      const scorm = contents.scorm.get(ch.chapterId)!;
      const capNStr = String(ch.chapterNumber);
      const scormZipName = `scorm_cap${capNStr}.zip`;
      const indexHtml = scorm.html;
      const manifestXml = scorm.manifestXml;

      const scormZip = new JSZip();
      scormZip.file('index.html', indexHtml);
      scormZip.file('imsmanifest.xml', manifestXml);
      const scormZipData = await scormZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });

      const zipHash = sha1Buf(Buffer.from(scormZipData));
      const indexHash = sha1Buf(indexHtml);
      const manifestHash = sha1Buf(manifestXml);
      const emptyHash = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

      zip.file(`files/${zipHash.substring(0, 2)}/${zipHash}`, scormZipData);
      zip.file(`files/${indexHash.substring(0, 2)}/${indexHash}`, indexHtml);
      zip.file(`files/${manifestHash.substring(0, 2)}/${manifestHash}`, manifestXml);
      zip.file(`files/${emptyHash.substring(0, 2)}/${emptyHash}`, '');

      const fid1 = fileId++; const fid2 = fileId++; const fid3 = fileId++; const fid4 = fileId++; const fid5 = fileId++;
      filesXmlEntries.push({ id: fid1, hash: manifestHash, ctx: scormCtx, comp: 'mod_scorm', area: 'content', item: 0, path: '/', name: 'imsmanifest.xml', size: textBytes(manifestXml), mime: 'application/xml' });
      filesXmlEntries.push({ id: fid2, hash: emptyHash, ctx: scormCtx, comp: 'mod_scorm', area: 'content', item: 0, path: '/', name: '.', size: 0, mime: '$@NULL@$' });
      filesXmlEntries.push({ id: fid3, hash: indexHash, ctx: scormCtx, comp: 'mod_scorm', area: 'content', item: 0, path: '/', name: 'index.html', size: textBytes(indexHtml), mime: 'text/html' });
      filesXmlEntries.push({ id: fid4, hash: zipHash, ctx: scormCtx, comp: 'mod_scorm', area: 'package', item: 0, path: '/', name: scormZipName, size: scormZipData.length, mime: 'application/zip' });
      filesXmlEntries.push({ id: fid5, hash: emptyHash, ctx: scormCtx, comp: 'mod_scorm', area: 'package', item: 0, path: '/', name: '.', size: 0, mime: '$@NULL@$' });

      const scoOrg = scoIdCounter++; const scoItem = scoIdCounter++;
      const scoD1 = scoDataCounter++; const scoD2 = scoDataCounter++;
      const gradeItemId = 9000 + scormMid;
      const scormName = safeActivityName(`🎮 Actividad Interactiva Cap ${capNStr} — ${ch.title}`);
      const introHtmlFinal = sanitizeTokens(scormIntroHtml(ch));
      const scormDir = `activities/scorm_${scormMid}`;

      zip.file(`${scormDir}/scorm.xml`, scormActivityXml({ aid: scormAid, mid: scormMid, ctx: scormCtx, actName: scormName, scormZipName, introHtml: introHtmlFinal, zipHash, scoOrg, scoItem, scoD1, scoD2, capLabel: capNStr, ts }));
      zip.file(`${scormDir}/module.xml`, activityModuleXmlCompletion2(scormMid, 'scorm', mod.sectionNum, ts, MV.bv));
      zip.file(`${scormDir}/inforef.xml`, inforefFilesAndGrade([fid1, fid2, fid3, fid4, fid5], gradeItemId));
      zip.file(`${scormDir}/grades.xml`, activityGradeItemXml({ gradeItemId, itemName: scormName, itemModule: 'scorm', aid: scormAid, ts }));
      zip.file(`${scormDir}/roles.xml`, ACTIVITY_BOILERPLATE_ROLES);
      zip.file(`${scormDir}/calendar.xml`, ACTIVITY_BOILERPLATE_CALENDAR);
      zip.file(`${scormDir}/grade_history.xml`, ACTIVITY_BOILERPLATE_GRADE_HISTORY);
      zip.file(`${scormDir}/competencies.xml`, ACTIVITY_BOILERPLATE_COMPETENCIES);
      zip.file(`${scormDir}/filters.xml`, ACTIVITY_BOILERPLATE_FILTERS);
      // El resto de boilerplate (completion/comments/xapistate) también se necesita:
      zip.file(`${scormDir}/completion.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<completions>\n  <completionviews>\n  </completionviews>\n</completions>');
      zip.file(`${scormDir}/comments.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<comments>\n</comments>');
      zip.file(`${scormDir}/xapistate.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<xapistate>\n</xapistate>');

      mbzActivities.push({ mid: scormMid, secnum: mod.sectionNum, modname: 'scorm', title: scormName, dir: scormDir });
      actSettings.push({ mid: scormMid, modname: 'scorm', title: scormName });
      pushAct(mod.sectionNum, scormMid);
    }

    // ── Examen de módulo (solo si el Manifest lo incluye) ────────────────
    if (mod.examItemKey) {
      const gift = contents.examGift.get(mod.moduleId)!;
      const parsedQs = parseGIFT(gift);

      addLabel(mod.sectionNum, `ℹ️ Evaluación del módulo ${mod.moduleNumber}`, examDescriptionHtml(mod, parsedQs.length));

      const quizAid = actId++; const quizMid = modId++; const quizCtx = ctxId++;
      ctaMap[quizMid] = 'quiz';
      const gradeItemId = 9500 + quizMid;
      const examName = `📝 Evaluación del módulo ${mod.moduleNumber} — ${mod.title}`;

      const qCatTopId = 200000 + quizMid;
      const qCatDefaultId = 202000 + quizMid;
      const qCatId = 201000 + quizMid;
      const qBankEntryId = 210000 + quizMid * 200;
      const qVersionId = 220000 + quizMid * 200;
      const qId = 230000 + quizMid * 200;
      let answerId = 240000 + quizMid * 200;
      let matchId = 250000 + quizMid * 200;
      let tfId = 260000 + quizMid * 200;
      let mcOptionsId = 270000 + quizMid * 200;

      let questionInstancesXml = '';
      let questionBankEntriesXml = '';
      let slot = 1;
      const markPerQ = (100 / Math.max(parsedQs.length, 1)).toFixed(7);

      for (let qi = 0; qi < parsedQs.length; qi++) {
        const q = parsedQs[qi];
        const qbeId = qBankEntryId + qi;
        const qvId = qVersionId + qi;
        const thisQId = qId + qi;

        questionInstancesXml += `      <question_instance id="${280000 + quizMid * 200 + qi}">
        <quizid>${quizAid}</quizid><slot>${slot}</slot><page>${Math.ceil(slot / 5)}</page>
        <displaynumber>$@NULL@$</displaynumber><requireprevious>0</requireprevious>
        <maxmark>${markPerQ}</maxmark><quizgradeitemid>$@NULL@$</quizgradeitemid>
        <question_reference id="${290000 + quizMid * 200 + qi}">
          <usingcontextid>${quizCtx}</usingcontextid><component>mod_quiz</component>
          <questionarea>slot</questionarea><questionbankentryid>${qbeId}</questionbankentryid>
          <version>$@NULL@$</version>
        </question_reference>
      </question_instance>\n`;

        let pluginXml = '';
        if (q.type === 'multichoice') {
          let answersXml = '';
          for (const ansOpt of q.options) {
            answersXml += `                    <answer id="${answerId++}"><answertext>${xmlEsc(ansOpt.text)}</answertext><answerformat>0</answerformat><fraction>${ansOpt.correct ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer>\n`;
          }
          pluginXml = `<plugin_qtype_multichoice_question><answers>\n${answersXml}                  </answers><multichoice id="${mcOptionsId++}"><layout>0</layout><single>1</single><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>0</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>0</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>0</incorrectfeedbackformat><answernumbering>abc</answernumbering><shownumcorrect>0</shownumcorrect><showstandardinstruction>0</showstandardinstruction></multichoice></plugin_qtype_multichoice_question>`;
        } else if (q.type === 'truefalse') {
          const trueAId = answerId++; const falseAId = answerId++;
          pluginXml = `<plugin_qtype_truefalse_question><answers><answer id="${trueAId}"><answertext>Verdadero</answertext><answerformat>0</answerformat><fraction>${q.answer ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer><answer id="${falseAId}"><answertext>Falso</answertext><answerformat>0</answerformat><fraction>${!q.answer ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer></answers><truefalse id="${tfId++}"><trueanswer>${trueAId}</trueanswer><falseanswer>${falseAId}</falseanswer><showstandardinstruction>0</showstandardinstruction></truefalse></plugin_qtype_truefalse_question>`;
        } else if (q.type === 'match') {
          let matchesXml = '';
          for (const pair of q.pairs) {
            matchesXml += `                    <match id="${matchId++}"><questiontext>${xmlEsc(pair.q)}</questiontext><questiontextformat>0</questiontextformat><answertext>${xmlEsc(pair.a)}</answertext></match>\n`;
          }
          pluginXml = `<plugin_qtype_match_question><matchoptions id="${mcOptionsId++}"><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>0</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>0</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>0</incorrectfeedbackformat><shownumcorrect>0</shownumcorrect></matchoptions><matches>\n${matchesXml}                  </matches></plugin_qtype_match_question>`;
        } else if (q.type === 'shortanswer') {
          let saXml = '';
          for (const ansTxt of q.answers) {
            saXml += `                    <answer id="${answerId++}"><answertext>${xmlEsc(ansTxt)}</answertext><answerformat>0</answerformat><fraction>1.0000000</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer>\n`;
          }
          pluginXml = `<plugin_qtype_shortanswer_question><answers>\n${saXml}                  </answers><shortanswer id="${mcOptionsId++}"><usecase>0</usecase></shortanswer></plugin_qtype_shortanswer_question>`;
        }

        questionBankEntriesXml += `      <question_bank_entry id="${qbeId}">
        <questioncategoryid>${qCatId}</questioncategoryid><idnumber>$@NULL@$</idnumber><ownerid>2</ownerid>
        <question_version><question_versions id="${qvId}"><version>1</version><status>ready</status>
        <questions><question id="${thisQId}">
          <parent>0</parent><name>${q.name || 'Q-' + (qi + 1)}</name>
          <questiontext>${xmlEsc(q.text)}</questiontext><questiontextformat>0</questiontextformat>
          <generalfeedback></generalfeedback><generalfeedbackformat>0</generalfeedbackformat>
          <defaultmark>1.0000000</defaultmark><penalty>0.3333333</penalty><qtype>${q.type}</qtype>
          <length>1</length><stamp>cursia.dynamic+${ts}+${Math.random().toString(36).substring(2, 8)}</stamp>
          <timecreated>${ts}</timecreated><timemodified>${ts}</timemodified>
          <createdby>2</createdby><modifiedby>2</modifiedby>
          ${pluginXml}
          <plugin_qbank_comment_question><comments></comments></plugin_qbank_comment_question>
        </question></questions></question_versions></question_version>
      </question_bank_entry>\n`;
        slot++;
      }

      questionsXmlEntries.push({ catTopId: qCatTopId, catDefaultId: qCatDefaultId, catId: qCatId, ctxId: quizCtx, modId: quizMid, name: examName, entries: questionBankEntriesXml });

      const introHtmlQ = sanitizeTokens(`<p>${esc(examName)}</p>`);
      const quizDir = `activities/quiz_${quizMid}`;
      zip.file(`${quizDir}/quiz.xml`, quizActivityXml({ aid: quizAid, mid: quizMid, ctx: quizCtx, examName, introHtml: introHtmlQ, questionInstancesXml, ts }));
      zip.file(`${quizDir}/module.xml`, activityModuleXmlCompletion2(quizMid, 'quiz', mod.sectionNum, ts, MV.bv));
      zip.file(`${quizDir}/inforef.xml`, inforefQuiz(gradeItemId, qCatTopId, qCatDefaultId, qCatId));
      zip.file(`${quizDir}/grades.xml`, activityGradeItemXml({ gradeItemId, itemName: examName, itemModule: 'quiz', aid: quizAid, ts }));
      zip.file(`${quizDir}/roles.xml`, ACTIVITY_BOILERPLATE_ROLES);
      zip.file(`${quizDir}/calendar.xml`, ACTIVITY_BOILERPLATE_CALENDAR);
      zip.file(`${quizDir}/grade_history.xml`, ACTIVITY_BOILERPLATE_GRADE_HISTORY);
      zip.file(`${quizDir}/competencies.xml`, ACTIVITY_BOILERPLATE_COMPETENCIES);
      zip.file(`${quizDir}/filters.xml`, ACTIVITY_BOILERPLATE_FILTERS);
      zip.file(`${quizDir}/completion.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<completions>\n  <completionviews>\n  </completionviews>\n</completions>');
      zip.file(`${quizDir}/comments.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<comments>\n</comments>');
      zip.file(`${quizDir}/xapistate.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<xapistate>\n</xapistate>');

      mbzActivities.push({ mid: quizMid, secnum: mod.sectionNum, modname: 'quiz', title: examName, dir: quizDir });
      actSettings.push({ mid: quizMid, modname: 'quiz', title: examName });
      pushAct(mod.sectionNum, quizMid);
    }
  }

  // ── Secciones ────────────────────────────────────────────────────────────
  const sectionDefs = deriveSectionDefs(plan);
  const secSettings: Array<{ num: number }> = [];
  for (const sd of sectionDefs) {
    secSettings.push({ num: sd.num });
    const seq = (secActs.get(sd.num) ?? []).join(',');
    zip.file(`sections/section_${sd.num}/section.xml`, sectionXml(sd, seq, ts));
    zip.file(`sections/section_${sd.num}/inforef.xml`, inforefXml());
    zip.file(`sections/section_${sd.num}/roles.xml`, SECTION_BOILERPLATE_ROLES);
    zip.file(`sections/section_${sd.num}/filters.xml`, SECTION_BOILERPLATE_FILTERS);
    zip.file(`sections/section_${sd.num}/contentbank.xml`, SECTION_BOILERPLATE_CONTENTBANK);
  }

  // ── course/* (mbz-builder.service.ts:1478-1505, adaptado) ───────────────
  const courseTitle = plan.course.title;
  zip.file('course/course.xml', `<?xml version="1.0" encoding="UTF-8"?>
<course id="1" contextid="1">
  <shortname>${esc(courseTitle)}</shortname><fullname>${esc(courseTitle)}</fullname>
  <idnumber></idnumber><summary>${xmlEsc(plan.course.summary ?? '')}</summary><summaryformat>1</summaryformat>
  <format>topics</format><showgrades>1</showgrades><newsitems>5</newsitems>
  <startdate>${ts}</startdate><enddate>0</enddate><marker>0</marker>
  <maxbytes>0</maxbytes><legacyfiles>0</legacyfiles><showreports>0</showreports>
  <visible>1</visible><groupmode>0</groupmode><groupmodeforce>0</groupmodeforce>
  <defaultgroupingid>0</defaultgroupingid><lang>es</lang><theme></theme>
  <timecreated>${ts}</timecreated><timemodified>${ts}</timemodified>
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
  zip.file('course/inforef.xml', inforefXml());
  zip.file('course/enrolments.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<enrolments>\n  <enrols>\n  </enrols>\n</enrolments>');
  zip.file('course/roles.xml', SECTION_BOILERPLATE_ROLES);
  zip.file('course/completiondefaults.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion_defaults>\n</course_completion_defaults>');
  zip.file('course/calendar.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>');
  zip.file('course/competencies.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_competencies>\n  <competencies>\n  </competencies>\n  <user_competencies>\n  </user_competencies>\n</course_competencies>');
  zip.file('course/contentbank.xml', SECTION_BOILERPLATE_CONTENTBANK);
  zip.file('course/filters.xml', SECTION_BOILERPLATE_FILTERS);

  // ── Root files (mbz-builder.service.ts:1509-1519) ───────────────────────
  zip.file('roles.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<roles_definition>\n</roles_definition>');
  zip.file('scales.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<scales_definition>\n</scales_definition>');
  zip.file('outcomes.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<outcomes_definition>\n</outcomes_definition>');
  zip.file('completion.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion>\n</course_completion>');
  zip.file('badges.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<badges>\n</badges>');
  zip.file('users.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<users>\n</users>');
  zip.file('activities/hvp_libraries.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<hvp_libraries>\n</hvp_libraries>');
  zip.file('grade_history.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>');
  zip.file('gradebook.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<gradebook>\n  <attributes>\n  </attributes>\n  <grade_categories>\n    <grade_category id="1">\n      <parent>$@NULL@$</parent><depth>1</depth><path>/1/</path><fullname>?</fullname>\n      <aggregation>13</aggregation><keephigh>0</keephigh><droplow>0</droplow>\n      <aggregateonlygraded>1</aggregateonlygraded><aggregateoutcomes>0</aggregateoutcomes>\n      <timecreated>${ts}</timecreated><timemodified>${ts}</timemodified><hidden>0</hidden>\n    </grade_category>\n  </grade_categories>\n  <grade_items>\n    <grade_item id="1">\n      <categoryid>$@NULL@$</categoryid><itemname>$@NULL@$</itemname><itemtype>course</itemtype>\n      <itemmodule>$@NULL@$</itemmodule><iteminstance>1</iteminstance><itemnumber>$@NULL@$</itemnumber>\n      <iteminfo>$@NULL@$</iteminfo><idnumber>$@NULL@$</idnumber><calculation>$@NULL@$</calculation>\n      <gradetype>1</gradetype><grademax>100.00000</grademax><grademin>0.00000</grademin>\n      <scaleid>$@NULL@$</scaleid><outcomeid>$@NULL@$</outcomeid><gradepass>0.00000</gradepass>\n      <multfactor>1.00000</multfactor><plusfactor>0.00000</plusfactor>\n      <aggregationcoef>0.00000</aggregationcoef><aggregationcoef2>0.00000</aggregationcoef2>\n      <weightoverride>0</weightoverride><sortorder>1</sortorder><display>0</display>\n      <decimals>$@NULL@$</decimals><hidden>0</hidden><locked>0</locked><locktime>0</locktime>\n      <needsupdate>0</needsupdate><timecreated>${ts}</timecreated><timemodified>${ts}</timemodified>\n      <grade_grades></grade_grades>\n    </grade_item>\n  </grade_items>\n  <grade_letters></grade_letters>\n  <grade_settings></grade_settings>\n</gradebook>`);
  zip.file('groups.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<groups>\n  <groupcustomfields>\n  </groupcustomfields>\n  <groupings>\n    <groupingcustomfields>\n    </groupingcustomfields>\n  </groupings>\n</groups>');

  // ── questions.xml (mbz-builder.service.ts:1522-1529) ────────────────────
  let questionsXmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<question_categories>\n';
  for (const qe of questionsXmlEntries) {
    questionsXmlContent += `  <question_category id="${qe.catTopId}">\n    <name>top</name>\n    <contextid>${qe.ctxId}</contextid><contextlevel>70</contextlevel><contextinstanceid>${qe.modId}</contextinstanceid>\n    <info></info><infoformat>0</infoformat>\n    <stamp>cursia.dynamic+${ts}+${Math.random().toString(36).substring(2, 8)}</stamp>\n    <parent>0</parent><sortorder>0</sortorder><idnumber>$@NULL@$</idnumber>\n    <question_bank_entries></question_bank_entries>\n  </question_category>\n`;
    questionsXmlContent += `  <question_category id="${qe.catDefaultId}">\n    <name>${xmlEsc('Por defecto en ' + qe.name)}</name>\n    <contextid>${qe.ctxId}</contextid><contextlevel>70</contextlevel><contextinstanceid>${qe.modId}</contextinstanceid>\n    <info>${xmlEsc('Categoría por defecto para preguntas compartidas en el contexto ' + qe.name + '.')}</info><infoformat>0</infoformat>\n    <stamp>cursia.dynamic+${ts}+${Math.random().toString(36).substring(2, 8)}</stamp>\n    <parent>${qe.catTopId}</parent><sortorder>999</sortorder><idnumber>$@NULL@$</idnumber>\n    <question_bank_entries></question_bank_entries>\n  </question_category>\n`;
    questionsXmlContent += `  <question_category id="${qe.catId}">\n    <name>${xmlEsc(qe.name)}</name>\n    <contextid>${qe.ctxId}</contextid><contextlevel>70</contextlevel><contextinstanceid>${qe.modId}</contextinstanceid>\n    <info></info><infoformat>0</infoformat>\n    <stamp>cursia.dynamic+${ts}+${Math.random().toString(36).substring(2, 8)}</stamp>\n    <parent>${qe.catTopId}</parent><sortorder>999</sortorder><idnumber>$@NULL@$</idnumber>\n    <question_bank_entries>\n${qe.entries}    </question_bank_entries>\n  </question_category>\n`;
  }
  questionsXmlContent += '</question_categories>';
  zip.file('questions.xml', questionsXmlContent);

  // ── files.xml (mbz-builder.service.ts:1533-1545) ────────────────────────
  let filesXmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<files>\n';
  for (const fe of filesXmlEntries) {
    filesXmlContent +=
      `  <file id="${fe.id}">\n    <contenthash>${fe.hash}</contenthash>\n    <contextid>${fe.ctx}</contextid>\n` +
      `    <component>${fe.comp}</component>\n    <filearea>${fe.area}</filearea>\n    <itemid>${fe.item ?? 0}</itemid>\n` +
      `    <filepath>${fe.path}</filepath>\n    <filename>${fe.name}</filename>\n    <userid>2</userid>\n` +
      `    <filesize>${fe.size}</filesize>\n    <mimetype>${fe.mime}</mimetype>\n    <status>0</status>\n` +
      `    <timecreated>${ts}</timecreated>\n    <timemodified>${ts}</timemodified>\n` +
      `    <source>${xmlEsc(fe.name)}</source>\n    <author>Cursia</author>\n    <license>allrightsreserved</license>\n` +
      `    <sortorder>0</sortorder>\n    <repositorytype>$@NULL@$</repositorytype>\n    <repositoryid>$@NULL@$</repositoryid>\n    <reference>$@NULL@$</reference>\n  </file>\n`;
  }
  filesXmlContent += '</files>';
  zip.file('files.xml', filesXmlContent);

  // ── moodle_backup.xml (mbz-builder.service.ts:1547-1619) ────────────────
  let contSections = '';
  for (const sd of sectionDefs) {
    contSections += `      <section>\n        <sectionid>${sd.num}</sectionid>\n        <title>${esc(sd.name)}</title>\n        <directory>sections/section_${sd.num}</directory>\n        <parentcmid></parentcmid>\n        <modname></modname>\n      </section>\n`;
  }
  let contActivities = '';
  for (const a of mbzActivities) {
    contActivities += `      <activity>\n        <moduleid>${a.mid}</moduleid>\n        <sectionid>${a.secnum}</sectionid>\n        <modulename>${a.modname}</modulename>\n        <title>${esc(a.title)}</title>\n        <directory>${a.dir}</directory>\n        <insubsection></insubsection>\n      </activity>\n`;
  }

  let settXml = '';
  const rootSettings: Record<string, string> = {
    filename: esc(courseTitle) + '.mbz', users: '0', anonymize: '0', role_assignments: '0',
    activities: '1', blocks: '0', files: '1', filters: '1', comments: '0', badges: '0',
    calendarevents: '1', userscompletion: '0', logs: '0', grade_histories: '0',
    questionbank: '1', groups: '0', competencies: '0', customfield: '0',
    contentbankcontent: '0', xapistate: '0', legacyfiles: '1',
  };
  for (const [k, v] of Object.entries(rootSettings)) {
    settXml += `    <setting>\n      <level>root</level>\n      <name>${k}</name>\n      <value>${v}</value>\n    </setting>\n`;
  }
  for (const s of secSettings) {
    settXml += `    <setting>\n      <level>section</level>\n      <section>section_${s.num}</section>\n      <name>section_${s.num}_included</name>\n      <value>1</value>\n    </setting>\n`;
    settXml += `    <setting>\n      <level>section</level>\n      <section>section_${s.num}</section>\n      <name>section_${s.num}_userinfo</name>\n      <value>0</value>\n    </setting>\n`;
  }
  for (const a of actSettings) {
    const pre = `${a.modname}_${a.mid}`;
    settXml += `    <setting>\n      <level>activity</level>\n      <activity>${pre}</activity>\n      <name>${pre}_included</name>\n      <value>1</value>\n    </setting>\n`;
    settXml += `    <setting>\n      <level>activity</level>\n      <activity>${pre}</activity>\n      <name>${pre}_userinfo</name>\n      <value>0</value>\n    </setting>\n`;
  }

  const mbXml = `<?xml version="1.0" encoding="UTF-8"?>
<moodle_backup>
<information>
  <name>${esc(courseTitle)}</name>
  <moodle_version>${MV.mv}</moodle_version>
  <moodle_release>${MV.mr}</moodle_release>
  <backup_version>${MV.bv}</backup_version>
  <backup_release>${MV.br}</backup_release>
  <backup_date>${ts}</backup_date>
  <mnet_remoteusers>0</mnet_remoteusers>
  <include_files>1</include_files>
  <include_file_references_to_external_content>0</include_file_references_to_external_content>
  <original_wwwroot>https://cursia.nomaddi.com</original_wwwroot>
  <original_site_identifier_hash>7723815fd5e7880d12bcade15abbbfc8</original_site_identifier_hash>
  <original_course_id>1</original_course_id>
  <original_course_fullname>${esc(courseTitle)}</original_course_fullname>
  <original_course_shortname>${esc(courseTitle)}</original_course_shortname>
  <original_course_format>topics</original_course_format>
  <original_course_startdate>${ts}</original_course_startdate>
  <original_course_enddate>0</original_course_enddate>
  <original_course_contextid>1</original_course_contextid>
  <original_system_contextid>1</original_system_contextid>
  <details>
    <detail backup_id="ccdyn${ts}">
      <type>course</type><format>moodle2</format><interactive>1</interactive>
      <mode>70</mode><execution>2</execution><executiontime>0</executiontime>
    </detail>
  </details>
  <contents>
    <activities>\n${contActivities}    </activities>
    <sections>\n${contSections}    </sections>
    <course>
      <courseid>1</courseid>
      <title>${esc(courseTitle)}</title>
      <directory>course</directory>
    </course>
  </contents>
  <settings>\n${settXml}  </settings>
</information>
</moodle_backup>`;
  zip.file('moodle_backup.xml', mbXml);

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  }) as unknown as Promise<Buffer>;
}
