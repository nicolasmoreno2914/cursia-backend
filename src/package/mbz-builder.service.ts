/**
 * mbz-builder.service.ts
 * Node.js/TypeScript port of 09-mbz.js exportMBZ().
 *
 * Key differences from the browser version:
 *   - SHA-1 via Node.js crypto (no crypto.subtle)
 *   - Audio as Buffer (not Blob)
 *   - H5P injected directly (no sentinel labels + mbzPatchToBlob pass)
 *   - zip.generateAsync({type:'nodebuffer'}) → returns Buffer
 *   - No DOM / document / alert / download trigger
 */

import { Injectable, Logger } from '@nestjs/common';
import * as JSZip from 'jszip';
import { createHash } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HvpEntry {
  hvpJson:    Record<string, any>;
  capName:    string;
  youtubeUrl: string;
  h5p_status?: string;
}

export interface MbzBuildInput {
  /** Course config object (D from frontend state). */
  courseData: Record<string, any>;
  /** Generated files map filename → content string (F from frontend). */
  courseFiles: Record<string, string>;
  /** Welcome audio MP3 buffer (optional). */
  audioWelcome?: Buffer | null;
  /** Audiobook MP3 buffer (optional). */
  audiobook?: Buffer | null;
  /** H5P activity data keyed by cap number 1-9 (MEDIA_HVP). */
  hvpData?: Record<number, HvpEntry>;
  /** Moodle version string, default '4.1'. */
  moodleVersion?: string;
}

export interface MbzBuildResult {
  buffer:       Buffer;
  filename:     string;
  sizeBytes:    number;
  activityCount: number;
  hasMoodleBackupXml: boolean;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class MbzBuilderService {
  private readonly logger = new Logger(MbzBuilderService.name);

  async buildMbz(input: MbzBuildInput): Promise<MbzBuildResult> {
    const D    = input.courseData  ?? {};
    const F    = input.courseFiles ?? {};
    const hvpDataMap: Record<number, HvpEntry> = input.hvpData ?? {};

    const keys = Object.keys(F);
    if (!keys.length) throw new Error('Sin archivos de curso en F — genera el contenido primero');

    const MOODLE_VERSIONS: Record<string, { mv: string; mr: string; bv: string; br: string }> = {
      '4.5': { mv:'2024100710', mr:'4.5.10 (Build: 20260216)', bv:'2024100700', br:'4.5' },
      '4.4': { mv:'2024042200', mr:'4.4 (Build: 20240422)',    bv:'2024042200', br:'4.4' },
      '4.1': { mv:'2022112800', mr:'4.1 (Build: 20221128)',    bv:'2022112800', br:'4.1' },
      '4.0': { mv:'2022041900', mr:'4.0 (Build: 20220419)',    bv:'2022041900', br:'4.0' },
      '3.11':{ mv:'2021051700', mr:'3.11 (Build: 20210517)',   bv:'2021051700', br:'3.11'},
      '3.9': { mv:'2020061500', mr:'3.9 (Build: 20200615)',    bv:'2020061500', br:'3.9' },
    };
    const MV = MOODLE_VERSIONS[input.moodleVersion ?? '4.1'] ?? MOODLE_VERSIONS['4.1'];

    const zip      = new JSZip();
    const nombre   = String(D.nombre ?? 'Curso Virtual');
    const ts       = Math.floor(Date.now() / 1000);
    const mods: any[]  = Array.isArray(D.mods) ? D.mods : [];
    const caps: any[]  = Array.isArray(D.caps) ? D.caps : [];
    const pal    = (D.pal ?? {}) as Record<string, string>;
    const dark   = pal.dark   ?? '#0A1A28';
    const accent = pal.accent ?? '#E8692A';

    const filesXmlEntries:    Array<Record<string, any>> = [];
    const questionsXmlEntries: Array<Record<string, any>> = [];

    let ctxId  = 2;
    let fileId = 10000;

    // ── Pure helpers ──────────────────────────────────────────────────────────

    function sha1Buf(data: Buffer | Uint8Array | string): string {
      const h = createHash('sha1');
      if (typeof data === 'string') h.update(data, 'utf8');
      else h.update(data);
      return h.digest('hex');
    }

    function textBytes(s: string): number {
      return Buffer.byteLength(s, 'utf8');
    }

    function esc(s: unknown): string {
      return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function xmlEsc(s: unknown): string {
      return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function friendlyName(fn: string): string {
      const capMap: Record<number, string> = {};
      caps.forEach((c: any) => { if (c.n != null && c.t) capMap[Number(c.n)] = c.t; });
      if (fn === 'seccion0_bienvenida.html')       return '🏠 Bienvenida al Curso';
      if (fn === 'seccion0_audio_bienvenida.html')  return '🎵 Audio de Bienvenida';
      if (fn === 'seccion0_introduccion.html')      return '📋 ¿Qué Aprenderás?';
      if (fn === 'seccion0_metodologia.html')       return '⚙️ Metodología del Curso';
      if (fn === 'seccion1_ruta_aprendizaje.html')  return '🗺️ Ruta de Aprendizaje';
      if (fn === 'seccion1_libro_guia.html')        return '📚 Libro Guía del Curso';
      if (fn === 'seccion1_audiolibro.html')        return '📻 Audiolibro del Curso';
      if (fn === 'examen_final_descripcion.html')   return 'ℹ️ Información: Examen Final';
      const vm = fn.match(/^cap(\d+)_video_interactivo\.html$/);
      if (vm) { const n = parseInt(vm[1]); return `▶️ Cap. ${n} — Video: ${capMap[n] ?? 'Capítulo ' + n}`; }
      const sm = fn.match(/^cap(\d+)_descripcion_actividad\.html$/);
      if (sm) { const n = parseInt(sm[1]); return `🎮 Cap. ${n} — Actividad Gamificada`; }
      const em = fn.match(/^examen_unidad(\d+)_descripcion\.html$/);
      if (em) return `ℹ️ Información: Examen Unidad ${em[1]}`;
      return fn.replace(/_/g, ' ').replace('.html', '').replace(/\b\w/g, l => l.toUpperCase());
    }

    function defMf(cap: { n: string | number; t: string }): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cap${cap.n}_juego" version="1.2" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="cap${cap.n}_org"><organization identifier="cap${cap.n}_org"><title>Cap ${cap.n}: ${cap.t}</title><item identifier="item_1" identifierref="resource_1"><title>Juego Cap ${cap.n}</title></item></organization></organizations>
  <resources><resource identifier="resource_1" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources>
</manifest>`;
    }

    // ── XML builders (identical templates to 09-mbz.js) ──────────────────────

    function moduleXml(mid: number, modname: string, secnum: number): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<module id="${mid}" version="${MV.bv}">
  <modulename>${modname}</modulename>
  <sectionid>${secnum}</sectionid>
  <sectionnumber>${secnum}</sectionnumber>
  <idnumber></idnumber>
  <added>${ts}</added>
  <score>0</score>
  <indent>0</indent>
  <visible>1</visible>
  <visibleoncoursepage>1</visibleoncoursepage>
  <visibleold>1</visibleold>
  <groupmode>0</groupmode>
  <groupingid>0</groupingid>
  <completion>0</completion>
  <completiongradeitemnumber>$@NULL@$</completiongradeitemnumber>
  <completionpassgrade>0</completionpassgrade>
  <completionview>0</completionview>
  <completionexpected>0</completionexpected>
  <availability>$@NULL@$</availability>
  <showdescription>${modname === 'label' ? '1' : '0'}</showdescription>
  <downloadcontent>1</downloadcontent>
  <lang></lang>
  <tags>
  </tags>
</module>`;
    }

    function pageXml(aid: number, mid: number, pgName: string, content: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${aid}" moduleid="${mid}" modulename="page" contextid="${ctxId++}">
  <page id="${aid}">
    <name>${esc(pgName)}</name>
    <intro></intro>
    <introformat>1</introformat>
    <content>${xmlEsc(content)}</content>
    <contentformat>1</contentformat>
    <legacyfiles>0</legacyfiles>
    <legacyfileslast>$@NULL@$</legacyfileslast>
    <display>5</display>
    <displayoptions>a:2:{s:12:"printheading";s:1:"1";s:10:"printintro";s:1:"0";}</displayoptions>
    <revision>1</revision>
    <timemodified>${ts}</timemodified>
  </page>
</activity>`;
    }

    function labelXml(aid: number, mid: number, name: string, content: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${aid}" moduleid="${mid}" modulename="label" contextid="${ctxId++}">
  <label id="${aid}">
    <name>${xmlEsc(name)}</name>
    <intro>${xmlEsc(content)}</intro>
    <introformat>1</introformat>
    <timemodified>${ts}</timemodified>
  </label>
</activity>`;
    }

    function inforefXml(): string {
      return `<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n</inforef>`;
    }

    function gradesXml(_aid: number): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<activity_gradebook>
  <grade_items>
  </grade_items>
  <grade_letters>
  </grade_letters>
</activity_gradebook>`;
    }

    function forumXml(aid: number, mid: number, name: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${aid}" moduleid="${mid}" modulename="forum" contextid="${ctxId++}">
  <forum id="${aid}">
    <type>news</type>
    <name>${xmlEsc(name)}</name>
    <intro></intro>
    <introformat>1</introformat>
    <duedate>0</duedate>
    <cutoffdate>0</cutoffdate>
    <assessed>0</assessed>
    <assesstimestart>0</assesstimestart>
    <assesstimefinish>0</assesstimefinish>
    <scale>0</scale>
    <maxbytes>0</maxbytes>
    <maxattachments>1</maxattachments>
    <forcesubscribe>1</forcesubscribe>
    <trackingtype>1</trackingtype>
    <rsstype>0</rsstype>
    <rssarticles>0</rssarticles>
    <timemodified>${ts}</timemodified>
    <warnafter>0</warnafter>
    <blockafter>0</blockafter>
    <blockperiod>0</blockperiod>
    <completiondiscussions>0</completiondiscussions>
    <completionreplies>0</completionreplies>
    <completionposts>0</completionposts>
    <displaywordcount>0</displaywordcount>
    <lockdiscussionafter>0</lockdiscussionafter>
    <grade_forum>0</grade_forum>
    <discussions>
    </discussions>
    <subscriptions>
    </subscriptions>
    <digests>
    </digests>
    <readposts>
    </readposts>
    <trackedprefs>
    </trackedprefs>
    <poststags>
    </poststags>
    <grades>
    </grades>
  </forum>
</activity>`;
    }

    function sectionXml(sec: { num: number; name: string; summary: string }, seqStr: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<section id="${sec.num}">
  <number>${sec.num}</number>
  <name>${esc(sec.name)}</name>
  <summary>${esc(sec.summary)}</summary>
  <summaryformat>1</summaryformat>
  <sequence>${seqStr}</sequence>
  <visible>1</visible>
  <availabilityjson>$@NULL@$</availabilityjson>
  <component>$@NULL@$</component>
  <itemid>$@NULL@$</itemid>
  <timemodified>${ts}</timemodified>
</section>`;
    }

    function hvpXml(
      aid: number, mid: number, ctx: number, capN: number,
      title: string, introHtml: string, hvpJson: Record<string, any>,
    ): string {
      const jc = JSON.stringify(hvpJson);
      return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${aid}" moduleid="${mid}" modulename="hvp" contextid="${ctx}">
  <hvp id="${aid}">
    <name>${xmlEsc(title)}</name>
    <machine_name>H5P.InteractiveVideo</machine_name>
    <major_version>1</major_version>
    <minor_version>27</minor_version>
    <intro>${xmlEsc(introHtml)}</intro>
    <introformat>1</introformat>
    <embed_type>div</embed_type>
    <disable>8</disable>
    <content_type>$@NULL@$</content_type>
    <source>$@NULL@$</source>
    <year_from>$@NULL@$</year_from>
    <year_to>$@NULL@$</year_to>
    <license_version>$@NULL@$</license_version>
    <changes>[]</changes>
    <license_extras>$@NULL@$</license_extras>
    <author_comments>$@NULL@$</author_comments>
    <slug>interactive-video-${capN}</slug>
    <timecreated>${ts}</timecreated>
    <timemodified>${ts}</timemodified>
    <authors>[]</authors>
    <license>U</license>
    <completionpass>0</completionpass>
    <json_content>${xmlEsc(jc)}</json_content>
    <content_user_data>
    </content_user_data>
    <metadata></metadata>
    <interactions></interactions>
    <tags>
    </tags>
  </hvp>
</activity>`;
    }

    function hvpModuleXml(mid: number, secnum: number): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<module id="${mid}" version="${MV.bv}">
  <modulename>hvp</modulename>
  <sectionid>${secnum}</sectionid>
  <sectionnumber>${secnum}</sectionnumber>
  <idnumber></idnumber>
  <added>${ts}</added>
  <score>0</score>
  <indent>0</indent>
  <visible>1</visible>
  <visibleoncoursepage>1</visibleoncoursepage>
  <visibleold>1</visibleold>
  <groupmode>0</groupmode>
  <groupingid>0</groupingid>
  <completion>2</completion>
  <completiongradeitemnumber>$@NULL@$</completiongradeitemnumber>
  <completionpassgrade>0</completionpassgrade>
  <completionview>1</completionview>
  <completionexpected>0</completionexpected>
  <availability>$@NULL@$</availability>
  <showdescription>1</showdescription>
  <downloadcontent>1</downloadcontent>
  <lang></lang>
  <tags>
  </tags>
</module>`;
    }

    function hvpGradesXml(aid: number, title: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<activity_gradebook>
  <grade_items>
    <grade_item id="${aid}">
      <categoryid>$@NULL@$</categoryid>
      <itemname>${xmlEsc(title)}</itemname>
      <itemtype>mod</itemtype>
      <itemmodule>hvp</itemmodule>
      <iteminstance>${aid}</iteminstance>
      <itemnumber>0</itemnumber>
      <iteminfo>$@NULL@$</iteminfo>
      <idnumber></idnumber>
      <calculation>$@NULL@$</calculation>
      <gradetype>1</gradetype>
      <grademax>10.00000</grademax>
      <grademin>0.00000</grademin>
      <scaleid>$@NULL@$</scaleid>
      <outcomeid>$@NULL@$</outcomeid>
      <gradepass>0.00000</gradepass>
      <multfactor>1.00000</multfactor>
      <plusfactor>0.00000</plusfactor>
      <aggregationcoef>0.00000</aggregationcoef>
      <aggregationcoef2>0.00000</aggregationcoef2>
      <weightoverride>0</weightoverride>
      <sortorder>1</sortorder>
      <display>0</display>
      <decimals>$@NULL@$</decimals>
      <hidden>0</hidden>
      <locked>0</locked>
      <locktime>0</locktime>
      <needsupdate>0</needsupdate>
      <timecreated>${ts}</timecreated>
      <timemodified>${ts}</timemodified>
      <grade_grades>
      </grade_grades>
    </grade_item>
  </grade_items>
  <grade_letters>
  </grade_letters>
</activity_gradebook>`;
    }

    function hvpInforefXml(gid: number): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<inforef>
  <grade_itemref>
    <grade_item>
      <id>${gid}</id>
    </grade_item>
  </grade_itemref>
</inforef>`;
    }

    async function buildH5PZip(hvpJsonObj: Record<string, any>, capNameStr: string): Promise<Uint8Array> {
      const meta = {
        title: capNameStr, language: 'es', mainLibrary: 'H5P.InteractiveVideo',
        embedTypes: ['div'], license: 'U',
        preloadedDependencies: [
          { machineName: 'H5P.InteractiveVideo', majorVersion: 1, minorVersion: 27 },
          { machineName: 'H5P.Video',             majorVersion: 1, minorVersion:  6 },
          { machineName: 'H5P.MultiChoice',        majorVersion: 1, minorVersion: 16 },
          { machineName: 'H5P.Summary',            majorVersion: 1, minorVersion: 10 },
          { machineName: 'H5P.JoubelUI',           majorVersion: 3, minorVersion:  3 },
          { machineName: 'H5P.Question',           majorVersion: 1, minorVersion:  5 },
          { machineName: 'H5P.Transition',         majorVersion: 1, minorVersion:  0 },
          { machineName: 'H5P.FontIcons',          majorVersion: 1, minorVersion:  0 },
          { machineName: 'FontAwesome',            majorVersion: 4, minorVersion:  5 },
        ],
      };
      const inner = new JSZip();
      inner.file('h5p.json', JSON.stringify(meta));
      inner.file('content/content.json', JSON.stringify(hvpJsonObj));
      return inner.generateAsync({ type: 'uint8array' });
    }

    function writeActFiles(d: string): void {
      zip.file(d + '/roles.xml',        '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>');
      zip.file(d + '/calendar.xml',     '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>');
      zip.file(d + '/grade_history.xml','<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>');
      zip.file(d + '/competencies.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_module_competencies>\n  <competencies>\n  </competencies>\n</course_module_competencies>');
      zip.file(d + '/filters.xml',      '<?xml version="1.0" encoding="UTF-8"?>\n<filters>\n  <filter_actives>\n  </filter_actives>\n  <filter_configs>\n  </filter_configs>\n</filters>');
      zip.file(d + '/completion.xml',   '<?xml version="1.0" encoding="UTF-8"?>\n<completions>\n  <completionviews>\n  </completionviews>\n</completions>');
      zip.file(d + '/comments.xml',     '<?xml version="1.0" encoding="UTF-8"?>\n<comments>\n</comments>');
      zip.file(d + '/xapistate.xml',    '<?xml version="1.0" encoding="UTF-8"?>\n<xapistate>\n</xapistate>');
    }

    // GIFT parser (identical to 08-downloads.js)
    function parseGIFT(gift: string): Array<Record<string, any>> {
      const questions: Array<Record<string, any>> = [];
      const lines = gift.split('\n');
      let i = 0;
      while (i < lines.length) {
        let line = lines[i].trim();
        if (!line || line.charAt(0) === '/' || line.indexOf('$CATEGORY:') === 0) { i++; continue; }
        let name = '';
        const nameMatch = line.match(/^::([^:]+)::/);
        if (nameMatch) { name = nameMatch[1].trim(); line = line.substring(nameMatch[0].length).trim(); }
        let fullLine = line;
        while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].trim().charAt(0) !== ':') {
          i++; fullLine += '\n' + lines[i].trim();
        }
        const braceStart = fullLine.indexOf('{');
        const braceEnd   = fullLine.lastIndexOf('}');
        if (braceStart < 0 || braceEnd < 0) { i++; continue; }
        let qText = fullLine.substring(0, braceStart).trim();
        if (!qText && name) qText = name;
        const ansBlock = fullLine.substring(braceStart + 1, braceEnd).trim();

        if (ansBlock.indexOf('->') >= 0) {
          const pairs: Array<{q:string;a:string}> = [];
          for (const ml of ansBlock.split('\n')) {
            const m = ml.trim();
            if (m.charAt(0) === '=') {
              const parts = m.substring(1).split('->');
              if (parts.length >= 2) pairs.push({ q: parts[0].trim(), a: parts.slice(1).join('->').trim() });
            }
          }
          if (pairs.length) questions.push({ type:'match', name, text:qText, pairs });
        } else if (['TRUE','FALSE','T','F','VERDADERO','FALSO'].includes(ansBlock)) {
          questions.push({ type:'truefalse', name, text:qText, answer: ['TRUE','T','VERDADERO'].includes(ansBlock) });
        } else if (ansBlock.indexOf('~') >= 0 || ansBlock.indexOf('=') === 0) {
          if (ansBlock.indexOf('~') < 0) {
            const saAnswers = ansBlock.split('\n').map(l => l.trim()).filter(l => l.charAt(0) === '=').map(l => l.substring(1).trim());
            if (saAnswers.length) questions.push({ type:'shortanswer', name, text:qText, answers:saAnswers });
          } else {
            const opts: Array<{text:string;correct:boolean}> = [];
            for (const ol of ansBlock.split('\n')) {
              const o = ol.trim(); if (!o) continue;
              if (o.charAt(0) === '=') { opts.push({ text: o.substring(1).trim(), correct: true }); }
              else if (o.charAt(0) === '~') { opts.push({ text: o.substring(1).trim().replace(/^%[-\d]+%\s*/, ''), correct: false }); }
            }
            if (opts.length) questions.push({ type:'multichoice', name, text:qText, options:opts });
          }
        }
        i++;
      }
      return questions;
    }

    // ── Chapter intro label HTML (shown as a separate label BEFORE the HVP) ───
    function hvpIntroHtml(capN: number, capName: string, modIdx: number, modName: string,
                           modHex: string, modAc: string, courseName: string): string {
      const modLabel = `MÓDULO ${modIdx + 1} · CAPÍTULO ${capN}`;
      const scormHref = `#scorm-cap-${capN}`;
      return `<div class="cc-responsive" style="width:100%;max-width:100%;overflow-x:auto;box-sizing:border-box;">`
        + `<div style="background:linear-gradient(160deg,#0A1A28,#0E2337,#12284A);border-radius:20px;padding:36px 40px;color:#E2E6F3;font-family:'Segoe UI',Arial,sans-serif;box-sizing:border-box;width:100%;max-width:100%;">`
        + `<div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">`
          + `<span style="display:inline-block;padding:5px 16px;border-radius:50px;background:${modHex};color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">${xmlEsc(modLabel)}</span>`
        + `</div>`
        + `<h2 style="font-size:30px;font-weight:800;color:#FFFFFF;margin:0 0 8px;line-height:1.2;">${xmlEsc(capName)}</h2>`
        + `<p style="font-size:13px;color:rgba(226,230,243,.5);margin:0 0 24px;font-family:'Segoe UI',Arial,sans-serif;">${xmlEsc(modName)} &nbsp;·&nbsp; ${xmlEsc(courseName)}</p>`
        + `<div style="height:2px;background:linear-gradient(90deg,${modHex},transparent);border-radius:2px;margin-bottom:24px;"></div>`
        + `<div style="background:rgba(37,99,235,.10);border:1px solid rgba(37,99,235,.22);border-radius:12px;padding:18px 22px;">`
          + `<div style="font-size:11px;font-weight:700;color:${modAc};text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px;">📺 Cómo aprovechar este video</div>`
          + `<ol style="margin:0;padding-left:20px;font-size:13px;color:rgba(226,230,243,.82);line-height:1.8;">`
            + `<li>Mira el video completo sin pausarlo manualmente.</li>`
            + `<li>Cuando aparezca una pregunta, <strong style="color:${modAc};">el video se pausará automáticamente</strong> — respóndela y continúa.</li>`
            + `<li>Usa las notas de capítulo para repasar los conceptos clave.</li>`
            + `<li>Al terminar, haz clic en <a href="${scormHref}" style="color:${modAc};font-weight:600;text-decoration:none;">Practicar ahora →</a> para la actividad gamificada.</li>`
          + `</ol>`
        + `</div>`
        + `</div></div>`;
    }

    // ── Chapter CTA label HTML (shown as a separate label AFTER the HVP, BEFORE SCORM) ─
    function hvpCtaHtml(capN: number, capName: string, modHex: string, modAc: string): string {
      const scormHref = `#scorm-cap-${capN}`;
      return `<div class="cc-responsive" style="width:100%;max-width:100%;overflow-x:auto;box-sizing:border-box;">`
        + `<div style="background:#0E1E33;border-radius:20px;padding:32px 40px;color:#E2E6F3;font-family:'Segoe UI',Arial,sans-serif;box-sizing:border-box;width:100%;max-width:100%;">`
        + `<h3 style="font-size:18px;font-weight:700;color:#FFFFFF;margin:0 0 6px;">✅ Temas cubiertos en este capítulo</h3>`
        + `<p style="font-size:13px;color:rgba(226,230,243,.5);margin:0 0 20px;">${xmlEsc(capName)}</p>`
        + `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:28px;">`
          + `<span style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 14px;font-size:12px;color:rgba(226,230,243,.7);">📌 Conceptos clave</span>`
          + `<span style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 14px;font-size:12px;color:rgba(226,230,243,.7);">💡 Aplicaciones prácticas</span>`
          + `<span style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 14px;font-size:12px;color:rgba(226,230,243,.7);">🔬 Ejemplos del campo</span>`
          + `<span style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 14px;font-size:12px;color:rgba(226,230,243,.7);">📋 Puntos a recordar</span>`
        + `</div>`
        + `<div style="background:linear-gradient(135deg,${modHex},#1a3a6e);border-radius:14px;padding:24px 28px;text-align:center;">`
          + `<p style="font-size:16px;font-weight:700;color:#FFFFFF;margin:0 0 6px;">¿Listo para poner a prueba lo aprendido?</p>`
          + `<p style="font-size:13px;color:rgba(255,255,255,.6);margin:0 0 18px;">Accede a la actividad gamificada y refuerza tu aprendizaje</p>`
          + `<a href="${scormHref}" style="display:inline-block;background:#FFFFFF;color:${modHex};font-size:15px;font-weight:700;padding:12px 32px;border-radius:50px;text-decoration:none;letter-spacing:.5px;">🎮 Practicar ahora →</a>`
          + `<p style="font-size:11px;color:rgba(255,255,255,.4);margin:12px 0 0;">📊 Reporta calificación &nbsp;·&nbsp; Intentos ilimitados</p>`
        + `</div>`
        + `</div></div>`;
    }

    // ── Section map (same as 09-mbz.js) ──────────────────────────────────────

    const sections = [
      { num:0, name:'Bienvenida e Introducción',   summary:'Sección inicial del curso: bienvenida, audio, introducción al curso y metodología.' },
      { num:1, name:'Ruta de Aprendizaje y Libro Guía', summary:'Mapa de la ruta formativa y acceso al libro guía del curso.' },
      { num:2, name:'Módulo 1 — ' + (mods[0] ? mods[0].n : 'Fundamentos'), summary:'Capítulos 1, 2 y 3 con videos interactivos, actividades gamificadas y examen de unidad.' },
      { num:3, name:'Módulo 2 — ' + (mods[1] ? mods[1].n : 'Aplicación'),  summary:'Capítulos 4, 5 y 6 con videos interactivos, actividades gamificadas y examen de unidad.' },
      { num:4, name:'Módulo 3 — ' + (mods[2] ? mods[2].n : 'Proyecto'),    summary:'Capítulos 7, 8 y 9 con videos interactivos, actividades gamificadas y examen de unidad.' },
      { num:5, name:'Cierre y Examen Final',        summary:'Página de cierre del curso y examen final integrador.' },
    ];

    const secFiles: Record<number, string[]> = { 0:[], 1:[], 2:[], 3:[], 4:[], 5:[] };
    secFiles[0] = ['seccion0_bienvenida.html','seccion0_audio_bienvenida.html','seccion0_introduccion.html','seccion0_metodologia.html'];
    secFiles[1] = ['seccion1_ruta_aprendizaje.html','seccion1_libro_guia.html','seccion1_audiolibro.html'];
    for (let ci = 0; ci < 9; ci++) {
      const sec = ci < 3 ? 2 : ci < 6 ? 3 : 4;
      const cn  = ci + 1;
      secFiles[sec].push(`cap${cn}_video_interactivo.html`);
      secFiles[sec].push(`scorm_cap${cn}_index.html`);
    }
    secFiles[2].push('examen_unidad1_descripcion.html', 'examen_unidad1.gift');
    secFiles[3].push('examen_unidad2_descripcion.html', 'examen_unidad2.gift');
    secFiles[4].push('examen_unidad3_descripcion.html', 'examen_unidad3.gift');
    secFiles[5].push('examen_final_descripcion.html',   'examen_final.gift');

    // ── Activity counters ─────────────────────────────────────────────────────

    let actId          = 1;
    let modId          = 953;
    let mbzFileId      = 1000;
    let scoIdCounter   = 50000;
    let scoDataCounter = 60000;

    const mbzActivities: Array<{mid:number;secnum:number;modname:string;title:string;dir:string}> = [];
    const secSettings:   Array<{num:number}> = [];
    const actSettings:   Array<{mid:number;modname:string;title:string}> = [];
    const htmlActivities: Array<{mid:number;dir:string;name:string;content:string;isLabel:boolean;capNum:number|null}> = [];
    const scormIntros:   Array<Record<string, any>> = [];
    const hvpActivities: Array<{dir:string;aid:number;mid:number;hvpCtx:number;title:string;capN:number;rawIntro:string;hvpJson:Record<string,any>}> = [];
    let   libroMid:      number | null = null;

    // Audiobook size limit (same as 09-mbz.js: 30 MB)
    const MBZ_AUDIOBOOK_MAX_BYTES = 30 * 1024 * 1024;
    let   effectiveAudiobook      = input.audiobook ?? null;
    if (effectiveAudiobook && effectiveAudiobook.length > MBZ_AUDIOBOOK_MAX_BYTES) {
      this.logger.warn(`[MbzBuilder] Audiobook too large (${(effectiveAudiobook.length / 1024 / 1024).toFixed(1)} MB) — excluded from MBZ`);
      effectiveAudiobook = null;
      // Replace the audiobook HTML with a friendly message
      const abMb = ((input.audiobook?.length ?? 0) / 1024 / 1024).toFixed(1);
      F['seccion1_audiolibro.html'] =
        `<div style="font-family:'Segoe UI',Arial,sans-serif;padding:40px 32px;text-align:center;` +
        `background:linear-gradient(160deg,#0A1A28,#0E2337);border-radius:20px;color:#E2E6F3;">` +
        `<div style="font-size:48px;margin-bottom:16px;">🎧</div>` +
        `<h2 style="font-size:22px;font-weight:700;margin:0 0 10px;">Audiolibro disponible por separado</h2>` +
        `<p style="font-size:14px;color:rgba(226,230,243,.65);max-width:400px;margin:0 auto 20px;line-height:1.7;">` +
        `El audiolibro de este curso está listo, pero no se incluye en este paquete porque es demasiado grande (${abMb} MB). ` +
        `Puedes descargarlo directamente desde la plataforma.</p></div>`;
    }

    // ── Forum (section 0 first activity) ─────────────────────────────────────

    const forumAid = actId++; const forumMid = modId++;
    const forumDir = `activities/forum_${forumMid}`;
    zip.file(forumDir + '/forum.xml',       forumXml(forumAid, forumMid, '📢 Avisos del Curso'));
    zip.file(forumDir + '/module.xml',      moduleXml(forumMid, 'forum', 0));
    zip.file(forumDir + '/inforef.xml',     inforefXml());
    zip.file(forumDir + '/grades.xml',      gradesXml(forumAid));
    zip.file(forumDir + '/posts.xml',       '<?xml version="1.0" encoding="UTF-8"?><posts></posts>');
    zip.file(forumDir + '/subscribers.xml','<?xml version="1.0" encoding="UTF-8"?><subscribers></subscribers>');
    zip.file(forumDir + '/discussions.xml','<?xml version="1.0" encoding="UTF-8"?><discussions></discussions>');
    writeActFiles(forumDir);
    mbzActivities.push({ mid:forumMid, secnum:0, modname:'forum', title:'📢 Avisos del Curso', dir:forumDir });
    actSettings.push({ mid:forumMid, modname:'forum', title:'📢 Avisos del Curso' });
    const sec0Seq: number[] = [forumMid];

    // ── Main activity loop ────────────────────────────────────────────────────

    for (const sec of sections) {
      const secActs: Array<{mid:number}> = [];
      const fileList = secFiles[sec.num] ?? [];
      secSettings.push({ num: sec.num });

      for (const fn of fileList) {
        if (!F[fn]) {
          if (fn.endsWith('.gift')) continue;
          const aid = actId++; const mid = modId++;
          const dir = `activities/label_${mid}`;
          const missingName    = `⚠️ Pendiente: ${fn}`;
          const missingContent = `<div style="background:#1a0a0a;border:2px solid #EF4444;border-radius:8px;padding:16px;color:#FCA5A5;font-family:sans-serif;"><strong>⚠️ Este contenido no se generó correctamente.</strong><br><small>Archivo: ${fn}</small></div>`;
          zip.file(dir + '/label.xml',  labelXml(mid, mid, missingName, missingContent));
          zip.file(dir + '/module.xml', moduleXml(mid, 'label', sec.num));
          zip.file(dir + '/inforef.xml', inforefXml());
          zip.file(dir + '/grades.xml',  gradesXml(aid));
          writeActFiles(dir);
          secActs.push({ mid });
          mbzActivities.push({ mid, secnum:sec.num, modname:'label', title:missingName, dir });
          actSettings.push({ mid, modname:'label', title:missingName });
          continue;
        }

        const isScormIdx = fn.startsWith('scorm_') && fn.endsWith('_index.html');
        const isGift     = fn.endsWith('.gift');
        const isHtml     = fn.endsWith('.html');

        // ── SCORM (preceded by a CTA label) ────────────────────────────────────
        if (isScormIdx) {
          const capNMatch = fn.match(/cap(\d+)/);
          const capNStr = capNMatch ? capNMatch[1] : 'X';
          const capIdx2 = capNMatch ? parseInt(capNMatch[1]) : 0;

          // ── CTA label inserted before each SCORM ──────────────────────────
          // Uses hvpCtaHtml() with the module colour palette.
          const ctaModIdx = capIdx2 <= 3 ? 0 : capIdx2 <= 6 ? 1 : 2;
          const ctaPal    = D.pal ?? {};
          const ctaModHex = ctaModIdx === 0 ? (ctaPal.m1 ?? '#2563EB')
                          : ctaModIdx === 1 ? (ctaPal.m2 ?? '#16A085')
                                            : (ctaPal.m3 ?? '#7D3C98');
          const ctaModAc  = ctaModIdx === 0 ? (ctaPal.m1a ?? '#93C5FD')
                          : ctaModIdx === 1 ? (ctaPal.m2a ?? '#2DD4BF')
                                            : (ctaPal.m3a ?? '#C084FC');
          const ctaCapName = caps[capIdx2 - 1]?.t ?? `Capítulo ${capIdx2}`;
          const ctaContent = hvpCtaHtml(capIdx2, ctaCapName, ctaModHex, ctaModAc);

          const ctaAid = actId++; const ctaMid = modId++;
          const ctaTitle = `🎯 Practicar — Cap ${capNStr}`;
          const ctaDir   = `activities/label_${ctaMid}`;
          zip.file(ctaDir + '/label.xml',  labelXml(ctaAid, ctaMid, ctaTitle, ctaContent));
          zip.file(ctaDir + '/module.xml',  moduleXml(ctaMid, 'label', sec.num));
          zip.file(ctaDir + '/grades.xml',  gradesXml(ctaAid));
          zip.file(ctaDir + '/inforef.xml', inforefXml());
          writeActFiles(ctaDir);
          htmlActivities.push({ mid:ctaMid, dir:ctaDir, name:ctaTitle, content:ctaContent, isLabel:true, capNum:capIdx2 });
          secActs.push({ mid: ctaMid });
          mbzActivities.push({ mid:ctaMid, secnum:sec.num, modname:'label', title:ctaTitle, dir:ctaDir });
          actSettings.push({ mid:ctaMid, modname:'label', title:ctaTitle });

          const aid = actId++; const mid = modId++;
          const gradeItemId = 9000 + mid;
          let actName = `🎮 Actividad Interactiva Cap ${capNStr}`;
          if (caps[capIdx2 - 1]) actName += ` — ${caps[capIdx2 - 1].t}`;

          const xmlFn        = fn.replace('_index.html', '_manifest.xml');
          const scormZipName = `scorm_cap${capNStr}.zip`;
          const indexHtml    = F[fn];
          const manifestXml  = F[xmlFn] ?? defMf({ n: capNStr, t: actName });

          const scormZip = new JSZip();
          scormZip.file('index.html', indexHtml);
          scormZip.file('imsmanifest.xml', manifestXml);
          const scormZipData = await scormZip.generateAsync({ type:'uint8array', compression:'DEFLATE', compressionOptions:{level:6} });

          const zipHash      = sha1Buf(Buffer.from(scormZipData));
          const indexHash    = sha1Buf(indexHtml);
          const manifestHash = sha1Buf(manifestXml);
          const emptyHash    = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

          zip.file(`files/${zipHash.substring(0,2)}/${zipHash}`,       scormZipData);
          zip.file(`files/${indexHash.substring(0,2)}/${indexHash}`,    indexHtml);
          zip.file(`files/${manifestHash.substring(0,2)}/${manifestHash}`, manifestXml);
          zip.file(`files/${emptyHash.substring(0,2)}/${emptyHash}`,    '');

          const scCtx  = ctxId++;
          const fid1 = fileId++; const fid2 = fileId++; const fid3 = fileId++;
          const fid4 = fileId++; const fid5 = fileId++;
          filesXmlEntries.push({ id:fid1, hash:manifestHash, ctx:scCtx, comp:'mod_scorm', area:'content',  item:0, path:'/', name:'imsmanifest.xml', size:textBytes(manifestXml), mime:'application/xml' });
          filesXmlEntries.push({ id:fid2, hash:emptyHash,    ctx:scCtx, comp:'mod_scorm', area:'content',  item:0, path:'/', name:'.',               size:0,                       mime:'$@NULL@$' });
          filesXmlEntries.push({ id:fid3, hash:indexHash,    ctx:scCtx, comp:'mod_scorm', area:'content',  item:0, path:'/', name:'index.html',       size:textBytes(indexHtml),   mime:'text/html' });
          filesXmlEntries.push({ id:fid4, hash:zipHash,      ctx:scCtx, comp:'mod_scorm', area:'package',  item:0, path:'/', name:scormZipName,       size:scormZipData.length,    mime:'application/zip' });
          filesXmlEntries.push({ id:fid5, hash:emptyHash,    ctx:scCtx, comp:'mod_scorm', area:'package',  item:0, path:'/', name:'.',               size:0,                       mime:'$@NULL@$' });

          const descFn    = `cap${capNStr}_descripcion_actividad.html`;
          const introHtml = F[descFn] ?? '<p>Actividad interactiva SCORM</p>';
          const scoOrg  = scoIdCounter++;
          const scoItem = scoIdCounter++;
          const scoD1   = scoDataCounter++;
          const scoD2   = scoDataCounter++;
          const capLabel = capNStr;
          const dir = `activities/scorm_${mid}`;
          scormIntros.push({ dir, capNum:capIdx2, introHtml, aid, mid, scCtx, actName, scormZipName, zipHash, scoOrg, scoItem, scoD1, scoD2, capLabel, gradeItemId });

          // Write initial scorm.xml (will be overwritten after CTA rewrite)
          const scormXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${aid}" moduleid="${mid}" modulename="scorm" contextid="${scCtx}">
  <scorm id="${aid}">
    <name>${xmlEsc(actName)}</name>
    <scormtype>local</scormtype>
    <reference>${xmlEsc(scormZipName)}</reference>
    <intro>${xmlEsc(introHtml)}</intro>
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
    <sha1hash>${zipHash}</sha1hash>
    <md5hash></md5hash>
    <revision>1</revision>
    <launch>${scoItem}</launch>
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
    <timemodified>${ts}</timemodified>
    <completionstatusrequired>4</completionstatusrequired>
    <completionscorerequired>$@NULL@$</completionscorerequired>
    <completionstatusallscos>0</completionstatusallscos>
    <autocommit>0</autocommit>
    <scoes>
      <sco id="${scoOrg}">
        <manifest>cap${capLabel}_juego</manifest>
        <organization></organization>
        <parent>/</parent>
        <identifier>cap${capLabel}_org</identifier>
        <launch></launch>
        <scormtype></scormtype>
        <title>${xmlEsc(actName)}</title>
        <sortorder>1</sortorder>
        <sco_datas></sco_datas>
        <seq_ruleconds></seq_ruleconds>
        <seq_rolluprules></seq_rolluprules>
        <seq_objectives></seq_objectives>
        <sco_tracks></sco_tracks>
      </sco>
      <sco id="${scoItem}">
        <manifest>cap${capLabel}_juego</manifest>
        <organization>cap${capLabel}_org</organization>
        <parent>cap${capLabel}_org</parent>
        <identifier>item_1</identifier>
        <launch>index.html</launch>
        <scormtype>sco</scormtype>
        <title>${xmlEsc(actName)}</title>
        <sortorder>2</sortorder>
        <sco_datas>
          <sco_data id="${scoD1}"><name>isvisible</name><value>true</value></sco_data>
          <sco_data id="${scoD2}"><name>parameters</name><value></value></sco_data>
        </sco_datas>
        <seq_ruleconds></seq_ruleconds>
        <seq_rolluprules></seq_rolluprules>
        <seq_objectives></seq_objectives>
        <sco_tracks></sco_tracks>
      </sco>
    </scoes>
  </scorm>
</activity>`;
          zip.file(dir + '/scorm.xml',  scormXmlContent);
          zip.file(dir + '/module.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<module id="${mid}" version="2024100700">\n  <modulename>scorm</modulename>\n  <sectionid>${sec.num}</sectionid>\n  <sectionnumber>${sec.num}</sectionnumber>\n  <idnumber></idnumber>\n  <added>${ts}</added>\n  <score>0</score>\n  <indent>0</indent>\n  <visible>1</visible>\n  <visibleoncoursepage>1</visibleoncoursepage>\n  <visibleold>1</visibleold>\n  <groupmode>0</groupmode>\n  <groupingid>0</groupingid>\n  <completion>2</completion>\n  <completiongradeitemnumber>0</completiongradeitemnumber>\n  <completionpassgrade>0</completionpassgrade>\n  <completionview>0</completionview>\n  <completionexpected>0</completionexpected>\n  <availability>$@NULL@$</availability>\n  <showdescription>1</showdescription>\n  <downloadcontent>1</downloadcontent>\n  <lang></lang>\n  <tags>\n  </tags>\n</module>`);
          zip.file(dir + '/inforef.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n  <fileref>\n    <file><id>${fid1}</id></file>\n    <file><id>${fid2}</id></file>\n    <file><id>${fid3}</id></file>\n    <file><id>${fid4}</id></file>\n    <file><id>${fid5}</id></file>\n  </fileref>\n  <grade_itemref>\n    <grade_item><id>${gradeItemId}</id></grade_item>\n  </grade_itemref>\n</inforef>`);
          zip.file(dir + '/grades.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<activity_gradebook>\n  <grade_items>\n    <grade_item id="${gradeItemId}">\n      <categoryid>$@NULL@$</categoryid>\n      <itemname>${xmlEsc(actName)}</itemname>\n      <itemtype>mod</itemtype>\n      <itemmodule>scorm</itemmodule>\n      <iteminstance>${aid}</iteminstance>\n      <itemnumber>0</itemnumber>\n      <iteminfo>$@NULL@$</iteminfo>\n      <idnumber></idnumber>\n      <calculation>$@NULL@$</calculation>\n      <gradetype>1</gradetype>\n      <grademax>100.00000</grademax>\n      <grademin>0.00000</grademin>\n      <scaleid>$@NULL@$</scaleid>\n      <outcomeid>$@NULL@$</outcomeid>\n      <gradepass>0.00000</gradepass>\n      <multfactor>1.00000</multfactor>\n      <plusfactor>0.00000</plusfactor>\n      <aggregationcoef>0.00000</aggregationcoef>\n      <aggregationcoef2>0.00000</aggregationcoef2>\n      <weightoverride>0</weightoverride>\n      <sortorder>1</sortorder>\n      <display>0</display>\n      <decimals>$@NULL@$</decimals>\n      <hidden>0</hidden>\n      <locked>0</locked>\n      <locktime>0</locktime>\n      <needsupdate>0</needsupdate>\n      <timecreated>${ts}</timecreated>\n      <timemodified>${ts}</timemodified>\n      <grade_grades>\n      </grade_grades>\n    </grade_item>\n  </grade_items>\n  <grade_letters>\n  </grade_letters>\n</activity_gradebook>`);
          zip.file(dir + '/roles.xml',        '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>');
          zip.file(dir + '/calendar.xml',     '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>');
          zip.file(dir + '/grade_history.xml','<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>');
          zip.file(dir + '/competencies.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_module_competencies>\n  <competencies>\n  </competencies>\n</course_module_competencies>');
          zip.file(dir + '/filters.xml',      '<?xml version="1.0" encoding="UTF-8"?>\n<filters>\n  <filter_actives>\n  </filter_actives>\n  <filter_configs>\n  </filter_configs>\n</filters>');
          secActs.push({ mid });
          mbzActivities.push({ mid, secnum:sec.num, modname:'scorm', title:actName, dir });
          actSettings.push({ mid, modname:'scorm', title:actName });

        // ── GIFT Quiz ─────────────────────────────────────────────────────────
        } else if (isGift) {
          const giftContent = F[fn];
          const aid = actId++; const mid = modId++;
          const quizCtx     = ctxId++;
          const gradeItemId = 9500 + mid;
          const examMatch   = fn.match(/unidad(\d+)/i) ?? fn.match(/final/i);
          const examName    = (examMatch && examMatch[1]) ? `📝 Examen Unidad ${examMatch[1]}` : '📝 Examen Final';
          const parsedQs    = parseGIFT(giftContent);

          const qCatTopId     = 200000 + mid;
          const qCatDefaultId = 202000 + mid;
          const qCatId        = 201000 + mid;
          let   qBankEntryId  = 210000 + mid * 200;
          let   qVersionId    = 220000 + mid * 200;
          let   qId           = 230000 + mid * 200;
          let   answerId      = 240000 + mid * 200;
          let   matchId       = 250000 + mid * 200;
          let   tfId          = 260000 + mid * 200;
          let   mcOptionsId   = 270000 + mid * 200;

          let questionInstancesXml   = '';
          let questionBankEntriesXml = '';
          let slot = 1;
          const markPerQ = (100 / Math.max(parsedQs.length, 1)).toFixed(7);

          for (let qi = 0; qi < parsedQs.length; qi++) {
            const q     = parsedQs[qi];
            const qbeId = qBankEntryId + qi;
            const qvId  = qVersionId + qi;
            const thisQId = qId + qi;

            questionInstancesXml += `      <question_instance id="${280000 + mid*200 + qi}">
        <quizid>${aid}</quizid><slot>${slot}</slot><page>${Math.ceil(slot/5)}</page>
        <displaynumber>$@NULL@$</displaynumber><requireprevious>0</requireprevious>
        <maxmark>${markPerQ}</maxmark><quizgradeitemid>$@NULL@$</quizgradeitemid>
        <question_reference id="${290000 + mid*200 + qi}">
          <usingcontextid>${quizCtx}</usingcontextid><component>mod_quiz</component>
          <questionarea>slot</questionarea><questionbankentryid>${qBankEntryId + qi}</questionbankentryid>
          <version>$@NULL@$</version>
        </question_reference>
      </question_instance>\n`;

            let pluginXml = '';
            if (q.type === 'multichoice') {
              let answersXml = '';
              for (const ans of (q.options as Array<{text:string;correct:boolean}>)) {
                answersXml += `                    <answer id="${answerId++}"><answertext>${xmlEsc(ans.text)}</answertext><answerformat>0</answerformat><fraction>${ans.correct ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer>\n`;
              }
              pluginXml = `<plugin_qtype_multichoice_question><answers>\n${answersXml}                  </answers><multichoice id="${mcOptionsId++}"><layout>0</layout><single>1</single><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>0</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>0</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>0</incorrectfeedbackformat><answernumbering>abc</answernumbering><shownumcorrect>0</shownumcorrect><showstandardinstruction>0</showstandardinstruction></multichoice></plugin_qtype_multichoice_question>`;
            } else if (q.type === 'truefalse') {
              const trueAId = answerId++; const falseAId = answerId++;
              pluginXml = `<plugin_qtype_truefalse_question><answers><answer id="${trueAId}"><answertext>Verdadero</answertext><answerformat>0</answerformat><fraction>${q.answer ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer><answer id="${falseAId}"><answertext>Falso</answertext><answerformat>0</answerformat><fraction>${!q.answer ? '1.0000000' : '0.0000000'}</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer></answers><truefalse id="${tfId++}"><trueanswer>${trueAId}</trueanswer><falseanswer>${falseAId}</falseanswer><showstandardinstruction>0</showstandardinstruction></truefalse></plugin_qtype_truefalse_question>`;
            } else if (q.type === 'match') {
              let matchesXml = '';
              for (const pair of (q.pairs as Array<{q:string;a:string}>)) {
                matchesXml += `                    <match id="${matchId++}"><questiontext>${xmlEsc(pair.q)}</questiontext><questiontextformat>0</questiontextformat><answertext>${xmlEsc(pair.a)}</answertext></match>\n`;
              }
              pluginXml = `<plugin_qtype_match_question><matchoptions id="${mcOptionsId++}"><shuffleanswers>1</shuffleanswers><correctfeedback></correctfeedback><correctfeedbackformat>0</correctfeedbackformat><partiallycorrectfeedback></partiallycorrectfeedback><partiallycorrectfeedbackformat>0</partiallycorrectfeedbackformat><incorrectfeedback></incorrectfeedback><incorrectfeedbackformat>0</incorrectfeedbackformat><shownumcorrect>0</shownumcorrect></matchoptions><matches>\n${matchesXml}                  </matches></plugin_qtype_match_question>`;
            } else if (q.type === 'shortanswer') {
              let saXml = '';
              for (const ans of (q.answers as string[])) {
                saXml += `                    <answer id="${answerId++}"><answertext>${xmlEsc(ans)}</answertext><answerformat>0</answerformat><fraction>1.0000000</fraction><feedback></feedback><feedbackformat>0</feedbackformat></answer>\n`;
              }
              pluginXml = `<plugin_qtype_shortanswer_question><answers>\n${saXml}                  </answers><shortanswer id="${mcOptionsId++}"><usecase>0</usecase></shortanswer></plugin_qtype_shortanswer_question>`;
            }

            questionBankEntriesXml += `      <question_bank_entry id="${qbeId}">
        <questioncategoryid>${qCatId}</questioncategoryid><idnumber>$@NULL@$</idnumber><ownerid>2</ownerid>
        <question_version><question_versions id="${qvId}"><version>1</version><status>ready</status>
        <questions><question id="${thisQId}">
          <parent>0</parent><name>${q.name ?? 'Q-' + (qi + 1)}</name>
          <questiontext>${xmlEsc(q.text)}</questiontext><questiontextformat>0</questiontextformat>
          <generalfeedback></generalfeedback><generalfeedbackformat>0</generalfeedbackformat>
          <defaultmark>1.0000000</defaultmark><penalty>0.3333333</penalty><qtype>${q.type}</qtype>
          <length>1</length><stamp>campusvirtual.edu.co+${ts}+${Math.random().toString(36).substring(2, 8)}</stamp>
          <timecreated>${ts}</timecreated><timemodified>${ts}</timemodified>
          <createdby>2</createdby><modifiedby>2</modifiedby>
          ${pluginXml}
          <plugin_qbank_comment_question><comments></comments></plugin_qbank_comment_question>
        </question></questions></question_versions></question_version>
      </question_bank_entry>\n`;
            slot++;
          }

          questionsXmlEntries.push({ catTopId:qCatTopId, catDefaultId:qCatDefaultId, catId:qCatId, ctxId:quizCtx, modId:mid, name:examName, entries:questionBankEntriesXml });

          const descFnQ  = fn.replace('.gift', '').replace('examen_', '') + '_examen.html';
          const introHtmlQ = F[descFnQ] ?? `<p>${xmlEsc(examName)}</p>`;
          const dir = `activities/quiz_${mid}`;
          const quizXml = `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${aid}" moduleid="${mid}" modulename="quiz" contextid="${quizCtx}">
  <quiz id="${aid}">
    <name>${xmlEsc(examName)}</name><intro>${xmlEsc(introHtmlQ)}</intro><introformat>1</introformat>
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
    <timecreated>${ts}</timecreated><timemodified>${ts}</timemodified>
    <password></password><subnet></subnet><browsersecurity>-</browsersecurity>
    <delay1>0</delay1><delay2>0</delay2><showuserpicture>0</showuserpicture><showblocks>0</showblocks>
    <completionattemptsexhausted>0</completionattemptsexhausted><completionminattempts>0</completionminattempts>
    <allowofflineattempts>0</allowofflineattempts>
    <subplugin_quizaccess_seb_quiz></subplugin_quizaccess_seb_quiz>
    <quiz_grade_items></quiz_grade_items>
    <question_instances>\n${questionInstancesXml}    </question_instances>
    <sections><section id="${aid}"><firstslot>1</firstslot><heading></heading><shufflequestions>0</shufflequestions></section></sections>
    <feedbacks><feedback id="${300000+mid}"><feedbacktext></feedbacktext><feedbacktextformat>1</feedbacktextformat><mingrade>0.00000</mingrade><maxgrade>101.00000</maxgrade></feedback></feedbacks>
    <overrides></overrides><grades></grades><attempts></attempts>
  </quiz>
</activity>`;
          zip.file(dir + '/quiz.xml',   quizXml);
          zip.file(dir + '/module.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<module id="${mid}" version="2024100700">\n  <modulename>quiz</modulename>\n  <sectionid>${sec.num}</sectionid>\n  <sectionnumber>${sec.num}</sectionnumber>\n  <idnumber></idnumber>\n  <added>${ts}</added>\n  <score>0</score>\n  <indent>0</indent>\n  <visible>1</visible>\n  <visibleoncoursepage>1</visibleoncoursepage>\n  <visibleold>1</visibleold>\n  <groupmode>0</groupmode>\n  <groupingid>0</groupingid>\n  <completion>2</completion>\n  <completiongradeitemnumber>0</completiongradeitemnumber>\n  <completionpassgrade>0</completionpassgrade>\n  <completionview>0</completionview>\n  <completionexpected>0</completionexpected>\n  <availability>$@NULL@$</availability>\n  <showdescription>1</showdescription>\n  <downloadcontent>1</downloadcontent>\n  <lang></lang>\n  <tags>\n  </tags>\n</module>`);
          zip.file(dir + '/inforef.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n  <grade_itemref>\n    <grade_item><id>${gradeItemId}</id></grade_item>\n  </grade_itemref>\n  <question_categoryref>\n    <question_category><id>${qCatTopId}</id></question_category>\n    <question_category><id>${qCatDefaultId}</id></question_category>\n    <question_category><id>${qCatId}</id></question_category>\n  </question_categoryref>\n</inforef>`);
          zip.file(dir + '/grades.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<activity_gradebook>\n  <grade_items>\n    <grade_item id="${gradeItemId}">\n      <categoryid>$@NULL@$</categoryid>\n      <itemname>${xmlEsc(examName)}</itemname>\n      <itemtype>mod</itemtype>\n      <itemmodule>quiz</itemmodule>\n      <iteminstance>${aid}</iteminstance>\n      <itemnumber>0</itemnumber>\n      <iteminfo>$@NULL@$</iteminfo>\n      <idnumber></idnumber>\n      <calculation>$@NULL@$</calculation>\n      <gradetype>1</gradetype>\n      <grademax>100.00000</grademax>\n      <grademin>0.00000</grademin>\n      <scaleid>$@NULL@$</scaleid>\n      <outcomeid>$@NULL@$</outcomeid>\n      <gradepass>0.00000</gradepass>\n      <multfactor>1.00000</multfactor>\n      <plusfactor>0.00000</plusfactor>\n      <aggregationcoef>0.00000</aggregationcoef>\n      <aggregationcoef2>0.00000</aggregationcoef2>\n      <weightoverride>0</weightoverride>\n      <sortorder>1</sortorder>\n      <display>0</display>\n      <decimals>$@NULL@$</decimals>\n      <hidden>0</hidden>\n      <locked>0</locked>\n      <locktime>0</locktime>\n      <needsupdate>0</needsupdate>\n      <timecreated>${ts}</timecreated>\n      <timemodified>${ts}</timemodified>\n      <grade_grades>\n      </grade_grades>\n    </grade_item>\n  </grade_items>\n  <grade_letters>\n  </grade_letters>\n</activity_gradebook>`);
          zip.file(dir + '/roles.xml',        '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>');
          zip.file(dir + '/calendar.xml',     '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>');
          zip.file(dir + '/grade_history.xml','<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>');
          zip.file(dir + '/competencies.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_module_competencies>\n  <competencies>\n  </competencies>\n</course_module_competencies>');
          zip.file(dir + '/filters.xml',      '<?xml version="1.0" encoding="UTF-8"?>\n<filters>\n  <filter_actives>\n  </filter_actives>\n  <filter_configs>\n  </filter_configs>\n</filters>');
          secActs.push({ mid });
          mbzActivities.push({ mid, secnum:sec.num, modname:'quiz', title:examName, dir });
          actSettings.push({ mid, modname:'quiz', title:examName });

        // ── HTML activities (labels, pages, audio, HVP) ───────────────────────
        } else if (isHtml) {
          // Acepta tanto el sentinel "bare" (sin diseño, se usa la intro genérica)
          // como el sentinel seguido del HTML de diseño generado por IA (caso normal
          // cuando ya hay un video real: processMedia antepone el sentinel al diseño
          // existente en vez de reemplazarlo). Antes solo se aceptaba el match exacto,
          // por lo que el diseño real nunca se detectaba ni se preservaba.
          const hvpSentinelMatch = F[fn] && F[fn].match(/^<!-- HVP:(\d+) -->/);
          const hvpCapN          = hvpSentinelMatch ? parseInt(hvpSentinelMatch[1]) : null;
          const hvpDesignHtml    = hvpCapN !== null
            ? (F[fn] ?? '')
                .replace(/^<!-- HVP:\d+ -->/, '')
                .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
                .replace(/<script\b[\s\S]*?<\/script>/gi, '')
                .trim()
            : '';
          const isAudioBv   = fn === 'seccion0_audio_bienvenida.html';
          const isAudioAl   = fn === 'seccion1_audiolibro.html';
          const audioBuffer = isAudioBv ? (input.audioWelcome ?? null)
                            : isAudioAl ? effectiveAudiobook : null;

          // ── Audio label (binary audio file in ZIP, shown inline on course page) ──
          // Using a label (not a page) so the audio player appears inline without
          // requiring the student to navigate to a separate page.
          if ((isAudioBv || isAudioAl) && audioBuffer) {
            const aid = actId++; const mid = modId++;
            const audioLabelName = friendlyName(fn);
            const dir            = `activities/label_${mid}`;
            const audioMime      = 'audio/mpeg';
            const audioExt       = '.mp3';
            const audioFilename  = (isAudioBv ? 'audio_bienvenida' : 'audiolibro') + audioExt;
            const audioHash      = sha1Buf(audioBuffer);
            const audioFid       = fileId++;
            // Capture ctxId BEFORE labelXml increments it
            const audioLabelCtx  = ctxId;

            zip.file(`files/${audioHash.substring(0,2)}/${audioHash}`, audioBuffer);
            // File must be associated with mod_label / intro so @@PLUGINFILE@@ resolves
            filesXmlEntries.push({ id:audioFid, hash:audioHash, ctx:audioLabelCtx, comp:'mod_label', area:'intro', item:0, path:'/', name:audioFilename, size:audioBuffer.length, mime:audioMime });

            // Replace both <audio src="data:..."> and <source src="data:..."> patterns
            let audioLabelContent = (F[fn] ?? '');
            audioLabelContent = audioLabelContent
              .replace(/<source\b[^>]*\bsrc="data:[^"]*"[^>]*>/gi,
                `<source src="@@PLUGINFILE@@/${audioFilename}" type="${audioMime}">`)
              .replace(/(<audio\b[^>]*?)\s+src="data:[^"]*"/gi,
                `$1 src="@@PLUGINFILE@@/${audioFilename}"`);

            zip.file(dir + '/label.xml',   labelXml(aid, mid, audioLabelName, audioLabelContent));
            zip.file(dir + '/module.xml',  moduleXml(mid, 'label', sec.num));
            zip.file(dir + '/grades.xml',  gradesXml(aid));
            zip.file(dir + '/inforef.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n  <fileref>\n    <file><id>${audioFid}</id></file>\n  </fileref>\n</inforef>`);
            writeActFiles(dir);
            secActs.push({ mid });
            mbzActivities.push({ mid, secnum:sec.num, modname:'label', title:audioLabelName, dir });
            actSettings.push({ mid, modname:'label', title:audioLabelName });

          // ── HVP sentinel: insert intro label BEFORE, then create HVP ────────
          } else if (hvpCapN !== null && hvpDataMap[hvpCapN]) {
            const hd = hvpDataMap[hvpCapN];

            const hvpModIdx = hvpCapN <= 3 ? 0 : hvpCapN <= 6 ? 1 : 2;
            const hvpPal    = D.pal ?? {};
            const hvpModHex = hvpModIdx === 0 ? (hvpPal.m1 ?? '#2563EB')
                            : hvpModIdx === 1 ? (hvpPal.m2 ?? '#16A085')
                                              : (hvpPal.m3 ?? '#7D3C98');
            const hvpModAc  = hvpModIdx === 0 ? (hvpPal.m1a ?? '#93C5FD')
                            : hvpModIdx === 1 ? (hvpPal.m2a ?? '#2DD4BF')
                                              : (hvpPal.m3a ?? '#C084FC');
            const hvpModName = mods[hvpModIdx] ? mods[hvpModIdx].n : `Módulo ${hvpModIdx + 1}`;
            const capNameStr  = hd.capName ?? `Capítulo ${hvpCapN}`;

            // ── 1. Intro label (design context before the video) ────────────
            // Preferir el diseño real generado por IA (cap{N}_video_interactivo.html,
            // capturado en hvpDesignHtml) — solo cae al template genérico cuando el
            // sentinel vino "bare" (sin diseño, p.ej. video subido antes de generar contenido).
            const introAid  = actId++; const introMid = modId++;
            const introTitle = `📖 Capítulo ${hvpCapN}${hd.capName ? ' — ' + hd.capName : ''}`;
            const introContent = hvpDesignHtml
              || hvpIntroHtml(hvpCapN, capNameStr, hvpModIdx, hvpModName, hvpModHex, hvpModAc, nombre);
            const introDir = `activities/label_${introMid}`;
            zip.file(introDir + '/label.xml',  labelXml(introAid, introMid, introTitle, introContent));
            zip.file(introDir + '/module.xml',  moduleXml(introMid, 'label', sec.num));
            zip.file(introDir + '/grades.xml',  gradesXml(introAid));
            zip.file(introDir + '/inforef.xml', inforefXml());
            writeActFiles(introDir);
            // Also track in htmlActivities so CTA links get rewritten
            htmlActivities.push({ mid:introMid, dir:introDir, name:introTitle, content:introContent, isLabel:true, capNum:hvpCapN });
            secActs.push({ mid: introMid });
            mbzActivities.push({ mid:introMid, secnum:sec.num, modname:'label', title:introTitle, dir:introDir });
            actSettings.push({ mid:introMid, modname:'label', title:introTitle });

            // ── 2. HVP (minimal intro — design is in the preceding label) ───
            const aid     = actId++; const mid = modId++;
            const hvpCtx  = ctxId++;
            const hvpTitle = `🎥 Video Interactivo Cap ${hvpCapN}${hd.capName ? ' — ' + hd.capName : ''}`;
            const dir = `activities/hvp_${mid}`;
            // Minimal intro: just the chapter name (the full design is in the intro label)
            const minimalIntro = `<p style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:rgba(226,230,243,.6);margin:0;">${xmlEsc(capNameStr)}</p>`;

            zip.file(dir + '/hvp.xml',     hvpXml(aid, mid, hvpCtx, hvpCapN, hvpTitle, minimalIntro, hd.hvpJson));
            zip.file(dir + '/module.xml',  hvpModuleXml(mid, sec.num));
            zip.file(dir + '/grades.xml',  hvpGradesXml(aid, hvpTitle));
            zip.file(dir + '/inforef.xml', hvpInforefXml(aid));
            writeActFiles(dir);
            hvpActivities.push({ dir, aid, mid, hvpCtx, title:hvpTitle, capN:hvpCapN, rawIntro:minimalIntro, hvpJson:hd.hvpJson });
            secActs.push({ mid });
            mbzActivities.push({ mid, secnum:sec.num, modname:'hvp', title:hvpTitle, dir });
            actSettings.push({ mid, modname:'hvp', title:hvpTitle });

          // ── Standard label/page ───────────────────────────────────────────
          } else {
            const aid = actId++; const mid = modId++;
            const pgName    = friendlyName(fn);
            const useLabel  = true; // same as PAGE_FILES=[] in 09-mbz.js
            const modtype   = useLabel ? 'label' : 'page';
            const dir       = `activities/${modtype}_${mid}`;

            // Audio placeholder cleanup if no actual audio
            let fnContent = F[fn] ?? '';
            if ((isAudioBv || isAudioAl) && !audioBuffer && fnContent) {
              fnContent = fnContent.replace(
                /<audio\b[^>]*>[\s\S]*?<\/audio>/gi,
                '<div style="display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:16px 20px;margin:16px 0;">'
                + '<span style="font-size:24px;">🎧</span>'
                + '<div><div style="font-size:14px;font-weight:600;color:#E2E6F3;font-family:\'Segoe UI\',sans-serif;">Audio en preparación</div>'
                + '<div style="font-size:12px;color:rgba(226,230,243,.5);font-family:\'Segoe UI\',sans-serif;margin-top:3px;">El audio se agregará próximamente a este recurso.</div>'
                + '</div></div>'
              );
            }

            // Track libro_guia for CTA rewriting
            if (fn === 'seccion1_libro_guia.html' || fn.startsWith('libro_guia')) {
              libroMid = mid;
            }

            if (useLabel) {
              zip.file(dir + '/label.xml',   labelXml(aid, mid, pgName, fnContent));
              zip.file(dir + '/module.xml',  moduleXml(mid, 'label', sec.num));
            } else {
              zip.file(dir + '/page.xml',    pageXml(aid, mid, pgName, fnContent));
              zip.file(dir + '/module.xml',  moduleXml(mid, 'page', sec.num));
            }
            zip.file(dir + '/inforef.xml', inforefXml());
            zip.file(dir + '/grades.xml',  gradesXml(aid));
            writeActFiles(dir);

            htmlActivities.push({ mid, dir, name:pgName, content:fnContent, isLabel:useLabel,
              capNum: (() => { const m = pgName.match(/Cap\.\s*(\d+)/i); return m ? parseInt(m[1]) : null; })() });
            secActs.push({ mid });
            mbzActivities.push({ mid, secnum:sec.num, modname:modtype, title:pgName, dir });
            actSettings.push({ mid, modname:modtype, title:pgName });
          }
        } // isHtml
      } // fileList

      // Write section XML
      const seqStr = (sec.num === 0
        ? [...sec0Seq, ...secActs.map(a => a.mid)]
        : secActs.map(a => a.mid)
      ).join(',');
      zip.file(`sections/section_${sec.num}/section.xml`,       sectionXml(sec, seqStr));
      zip.file(`sections/section_${sec.num}/inforef.xml`,        inforefXml());
      zip.file(`sections/section_${sec.num}/roles.xml`,          '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>');
      zip.file(`sections/section_${sec.num}/filters.xml`,        '<?xml version="1.0" encoding="UTF-8"?>\n<filters>\n  <filter_actives>\n  </filter_actives>\n  <filter_configs>\n  </filter_configs>\n</filters>');
      zip.file(`sections/section_${sec.num}/contentbank.xml`,    '<?xml version="1.0" encoding="UTF-8"?>\n<contents>\n</contents>');
      if (sec.num > 0) {
        for (const a of secActs) sec0Seq.push(a.mid);
      }
    } // sections loop

    // ── CTA link rewriting ────────────────────────────────────────────────────

    const ctaMap: Record<number, string>  = {};
    const scormCapMap: Record<number, number> = {};
    const quizUnitMap: Record<number, number> = {};
    let   quizFinalMid: number | null = null;

    for (const a of mbzActivities) {
      ctaMap[a.mid] = a.modname;
      if (a.modname === 'scorm') {
        const m = a.title.match(/Cap\s+(\d+)/i);
        if (m) scormCapMap[parseInt(m[1])] = a.mid;
      }
      if (a.modname === 'quiz') {
        const m = a.title.match(/Unidad\s+(\d+)/i);
        if (m) quizUnitMap[parseInt(m[1])] = a.mid;
        if (/final/i.test(a.title)) quizFinalMid = a.mid;
      }
    }

    function rewriteCtaLinks(html: string, ctx: { capNum?: number | null }): string {
      html = html.replace(/(?:\$@COURSEVIEWBYID\*\d+@\$|https?:\/\/[^\s"']*\/course\/view\.php\?[^\s"'#]*)#module-(\d+)/g, (match, midStr) => {
        const mid = parseInt(midStr); const mn = ctaMap[mid];
        if (mn === 'scorm') return `$@SCORMVIEWBYID*${midStr}@$`;
        if (mn === 'quiz')  return `$@QUIZVIEWBYID*${midStr}@$`;
        if (mn === 'page')  return `$@PAGEVIEWBYID*${midStr}@$`;
        if (ctx.capNum) { const sm = scormCapMap[ctx.capNum]; if (sm) return `$@SCORMVIEWBYID*${sm}@$`; }
        return match;
      });
      html = html.replace(/#module-(\d+)/g, (match, midStr) => {
        const mid = parseInt(midStr); const mn = ctaMap[mid];
        if (mn === 'scorm') return `$@SCORMVIEWBYID*${midStr}@$`;
        if (mn === 'quiz')  return `$@QUIZVIEWBYID*${midStr}@$`;
        if (mn === 'page')  return `$@PAGEVIEWBYID*${midStr}@$`;
        if (ctx.capNum) { const sm = scormCapMap[ctx.capNum]; if (sm) return `$@SCORMVIEWBYID*${sm}@$`; }
        return match;
      });
      html = html.replace(/#scorm-cap-(\d+)/g, (match, capStr) => {
        const mid = scormCapMap[parseInt(capStr)]; return mid ? `$@SCORMVIEWBYID*${mid}@$` : match;
      });
      html = html.replace(/#exam-unit-(\d+)/g, (match, unitStr) => {
        const mid = quizUnitMap[parseInt(unitStr)]; return mid ? `$@QUIZVIEWBYID*${mid}@$` : match;
      });
      html = html.replace(/#exam-final/g, () => quizFinalMid ? `$@QUIZVIEWBYID*${quizFinalMid}@$` : '#exam-final');
      html = html.replace(/href="[^"]*\/mod\/scorm\/player\.php[^"]*"/g, (match) => {
        const m = match.match(/currentorg=cap(\d+)_/);
        if (m) { const mid = scormCapMap[parseInt(m[1])]; if (mid) return `href="$@SCORMVIEWBYID*${mid}@$"`; }
        return match;
      });
      if (libroMid) html = html.replace(/#libro-guia/g, `$@RESOURCEVIEWBYID*${libroMid}@$`);
      return html;
    }

    for (const h of htmlActivities) {
      const remapped = rewriteCtaLinks(h.content, { capNum: h.capNum });
      if (h.isLabel) zip.file(h.dir + '/label.xml', labelXml(h.mid, h.mid, h.name, remapped));
      else           zip.file(h.dir + '/page.xml',  pageXml(h.mid, h.mid, h.name, remapped));
    }
    for (const si of scormIntros) {
      const fixedIntro = rewriteCtaLinks(si.introHtml, { capNum: si.capNum });
      const rewrittenScorm = `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${si.aid}" moduleid="${si.mid}" modulename="scorm" contextid="${si.scCtx}">
  <scorm id="${si.aid}">
    <name>${xmlEsc(si.actName)}</name><scormtype>local</scormtype>
    <reference>${xmlEsc(si.scormZipName)}</reference>
    <intro>${xmlEsc(fixedIntro)}</intro><introformat>1</introformat>
    <version>SCORM_1.2</version><maxgrade>100</maxgrade><grademethod>1</grademethod>
    <whatgrade>0</whatgrade><maxattempt>0</maxattempt><forcecompleted>0</forcecompleted>
    <forcenewattempt>0</forcenewattempt><lastattemptlock>0</lastattemptlock>
    <masteryoverride>1</masteryoverride><displayattemptstatus>1</displayattemptstatus>
    <displaycoursestructure>0</displaycoursestructure><updatefreq>0</updatefreq>
    <sha1hash>${si.zipHash}</sha1hash><md5hash></md5hash><revision>1</revision>
    <launch>${si.scoItem}</launch><skipview>0</skipview><hidebrowse>0</hidebrowse>
    <hidetoc>0</hidetoc><nav>1</nav><navpositionleft>-100</navpositionleft><navpositiontop>-100</navpositiontop>
    <auto>0</auto><popup>0</popup><options></options><width>100</width><height>500</height>
    <timeopen>0</timeopen><timeclose>0</timeclose><timemodified>${ts}</timemodified>
    <completionstatusrequired>4</completionstatusrequired><completionscorerequired>$@NULL@$</completionscorerequired>
    <completionstatusallscos>0</completionstatusallscos><autocommit>0</autocommit>
    <scoes>
      <sco id="${si.scoOrg}"><manifest>cap${si.capLabel}_juego</manifest><organization></organization>
        <parent>/</parent><identifier>cap${si.capLabel}_org</identifier><launch></launch>
        <scormtype></scormtype><title>${xmlEsc(si.actName)}</title><sortorder>1</sortorder>
        <sco_datas></sco_datas><seq_ruleconds></seq_ruleconds><seq_rolluprules></seq_rolluprules>
        <seq_objectives></seq_objectives><sco_tracks></sco_tracks></sco>
      <sco id="${si.scoItem}"><manifest>cap${si.capLabel}_juego</manifest>
        <organization>cap${si.capLabel}_org</organization><parent>cap${si.capLabel}_org</parent>
        <identifier>item_1</identifier><launch>index.html</launch><scormtype>sco</scormtype>
        <title>${xmlEsc(si.actName)}</title><sortorder>2</sortorder>
        <sco_datas>
          <sco_data id="${si.scoD1}"><name>isvisible</name><value>true</value></sco_data>
          <sco_data id="${si.scoD2}"><name>parameters</name><value></value></sco_data>
        </sco_datas>
        <seq_ruleconds></seq_ruleconds><seq_rolluprules></seq_rolluprules>
        <seq_objectives></seq_objectives><sco_tracks></sco_tracks></sco>
    </scoes>
  </scorm>
</activity>`;
      zip.file(si.dir + '/scorm.xml', rewrittenScorm);
    }
    for (const h of hvpActivities) {
      const fixedIntro = rewriteCtaLinks(h.rawIntro, { capNum: h.capN });
      zip.file(h.dir + '/hvp.xml', hvpXml(h.aid, h.mid, h.hvpCtx, h.capN, h.title, fixedIntro, h.hvpJson));
    }

    // ── Course XML ────────────────────────────────────────────────────────────

    zip.file('course/course.xml', `<?xml version="1.0" encoding="UTF-8"?>
<course id="1" contextid="1">
  <shortname>${esc(nombre)}</shortname><fullname>${esc(nombre)}</fullname>
  <idnumber></idnumber><summary>${xmlEsc(D.obj ?? '')}</summary><summaryformat>1</summaryformat>
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
    zip.file('course/inforef.xml',           inforefXml());
    zip.file('course/enrolments.xml',        '<?xml version="1.0" encoding="UTF-8"?>\n<enrolments>\n  <enrols>\n  </enrols>\n</enrolments>');
    zip.file('course/roles.xml',             '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>');
    zip.file('course/completiondefaults.xml','<?xml version="1.0" encoding="UTF-8"?>\n<course_completion_defaults>\n</course_completion_defaults>');
    zip.file('course/calendar.xml',          '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>');
    zip.file('course/competencies.xml',      '<?xml version="1.0" encoding="UTF-8"?>\n<course_competencies>\n  <competencies>\n  </competencies>\n  <user_competencies>\n  </user_competencies>\n</course_competencies>');
    zip.file('course/contentbank.xml',       '<?xml version="1.0" encoding="UTF-8"?>\n<contents>\n</contents>');
    zip.file('course/filters.xml',           '<?xml version="1.0" encoding="UTF-8"?>\n<filters>\n  <filter_actives>\n  </filter_actives>\n  <filter_configs>\n  </filter_configs>\n</filters>');

    // ── Root XML files ────────────────────────────────────────────────────────

    zip.file('roles.xml',        '<?xml version="1.0" encoding="UTF-8"?>\n<roles_definition>\n</roles_definition>');
    zip.file('scales.xml',       '<?xml version="1.0" encoding="UTF-8"?>\n<scales_definition>\n</scales_definition>');
    zip.file('outcomes.xml',     '<?xml version="1.0" encoding="UTF-8"?>\n<outcomes_definition>\n</outcomes_definition>');
    zip.file('completion.xml',   '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion>\n</course_completion>');
    zip.file('badges.xml',       '<?xml version="1.0" encoding="UTF-8"?>\n<badges>\n</badges>');
    zip.file('users.xml',        '<?xml version="1.0" encoding="UTF-8"?>\n<users>\n</users>');
    zip.file('activities/hvp_libraries.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<hvp_libraries>\n</hvp_libraries>');
    zip.file('grade_history.xml','<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>');
    zip.file('gradebook.xml',    `<?xml version="1.0" encoding="UTF-8"?>\n<gradebook>\n  <attributes>\n  </attributes>\n  <grade_categories>\n    <grade_category id="1">\n      <parent>$@NULL@$</parent><depth>1</depth><path>/1/</path><fullname>?</fullname>\n      <aggregation>13</aggregation><keephigh>0</keephigh><droplow>0</droplow>\n      <aggregateonlygraded>1</aggregateonlygraded><aggregateoutcomes>0</aggregateoutcomes>\n      <timecreated>${ts}</timecreated><timemodified>${ts}</timemodified><hidden>0</hidden>\n    </grade_category>\n  </grade_categories>\n  <grade_items>\n    <grade_item id="1">\n      <categoryid>$@NULL@$</categoryid><itemname>$@NULL@$</itemname><itemtype>course</itemtype>\n      <itemmodule>$@NULL@$</itemmodule><iteminstance>1</iteminstance><itemnumber>$@NULL@$</itemnumber>\n      <iteminfo>$@NULL@$</iteminfo><idnumber>$@NULL@$</idnumber><calculation>$@NULL@$</calculation>\n      <gradetype>1</gradetype><grademax>100.00000</grademax><grademin>0.00000</grademin>\n      <scaleid>$@NULL@$</scaleid><outcomeid>$@NULL@$</outcomeid><gradepass>0.00000</gradepass>\n      <multfactor>1.00000</multfactor><plusfactor>0.00000</plusfactor>\n      <aggregationcoef>0.00000</aggregationcoef><aggregationcoef2>0.00000</aggregationcoef2>\n      <weightoverride>0</weightoverride><sortorder>1</sortorder><display>0</display>\n      <decimals>$@NULL@$</decimals><hidden>0</hidden><locked>0</locked><locktime>0</locktime>\n      <needsupdate>0</needsupdate><timecreated>${ts}</timecreated><timemodified>${ts}</timemodified>\n      <grade_grades></grade_grades>\n    </grade_item>\n  </grade_items>\n  <grade_letters></grade_letters>\n  <grade_settings></grade_settings>\n</gradebook>`);
    zip.file('groups.xml',       `<?xml version="1.0" encoding="UTF-8"?>\n<groups>\n  <groupcustomfields>\n  </groupcustomfields>\n  <groupings>\n    <groupingcustomfields>\n    </groupingcustomfields>\n  </groupings>\n</groups>`);

    // ── questions.xml ─────────────────────────────────────────────────────────

    let questionsXmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<question_categories>\n';
    for (const qe of questionsXmlEntries) {
      questionsXmlContent += `  <question_category id="${qe.catTopId}">\n    <name>top</name>\n    <contextid>${qe.ctxId}</contextid><contextlevel>70</contextlevel><contextinstanceid>${qe.modId}</contextinstanceid>\n    <info></info><infoformat>0</infoformat>\n    <stamp>campusvirtual.edu.co+${ts}+${Math.random().toString(36).substring(2,8)}</stamp>\n    <parent>0</parent><sortorder>0</sortorder><idnumber>$@NULL@$</idnumber>\n    <question_bank_entries></question_bank_entries>\n  </question_category>\n`;
      questionsXmlContent += `  <question_category id="${qe.catDefaultId}">\n    <name>${xmlEsc('Por defecto en ' + qe.name)}</name>\n    <contextid>${qe.ctxId}</contextid><contextlevel>70</contextlevel><contextinstanceid>${qe.modId}</contextinstanceid>\n    <info>${xmlEsc('Categoría por defecto para preguntas compartidas en el contexto ' + qe.name + '.')}</info><infoformat>0</infoformat>\n    <stamp>campusvirtual.edu.co+${ts}+${Math.random().toString(36).substring(2,8)}</stamp>\n    <parent>${qe.catTopId}</parent><sortorder>999</sortorder><idnumber>$@NULL@$</idnumber>\n    <question_bank_entries></question_bank_entries>\n  </question_category>\n`;
      questionsXmlContent += `  <question_category id="${qe.catId}">\n    <name>${xmlEsc(qe.name)}</name>\n    <contextid>${qe.ctxId}</contextid><contextlevel>70</contextlevel><contextinstanceid>${qe.modId}</contextinstanceid>\n    <info></info><infoformat>0</infoformat>\n    <stamp>campusvirtual.edu.co+${ts}+${Math.random().toString(36).substring(2,8)}</stamp>\n    <parent>${qe.catTopId}</parent><sortorder>999</sortorder><idnumber>$@NULL@$</idnumber>\n    <question_bank_entries>\n${qe.entries}    </question_bank_entries>\n  </question_category>\n`;
    }
    questionsXmlContent += '</question_categories>';
    zip.file('questions.xml', questionsXmlContent);

    // ── files.xml ─────────────────────────────────────────────────────────────

    let filesXmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<files>\n';
    for (const fe of filesXmlEntries) {
      filesXmlContent +=
        `  <file id="${fe.id}">\n    <contenthash>${fe.hash}</contenthash>\n    <contextid>${fe.ctx}</contextid>\n` +
        `    <component>${fe.comp}</component>\n    <filearea>${fe.area}</filearea>\n    <itemid>${fe.item ?? 0}</itemid>\n` +
        `    <filepath>${fe.path}</filepath>\n    <filename>${fe.name}</filename>\n    <userid>2</userid>\n` +
        `    <filesize>${fe.size}</filesize>\n    <mimetype>${fe.mime}</mimetype>\n    <status>0</status>\n` +
        `    <timecreated>${ts}</timecreated>\n    <timemodified>${ts}</timemodified>\n` +
        `    <source>${xmlEsc(fe.name)}</source>\n    <author>CampusCloud</author>\n    <license>allrightsreserved</license>\n` +
        `    <sortorder>0</sortorder>\n    <repositorytype>$@NULL@$</repositorytype>\n    <repositoryid>$@NULL@$</repositoryid>\n    <reference>$@NULL@$</reference>\n  </file>\n`;
    }
    filesXmlContent += '</files>';
    zip.file('files.xml', filesXmlContent);

    // ── moodle_backup.xml ─────────────────────────────────────────────────────

    let contSections = '';
    for (const s of sections) {
      contSections += `      <section>\n        <sectionid>${s.num}</sectionid>\n        <title>${esc(s.name)}</title>\n        <directory>sections/section_${s.num}</directory>\n        <parentcmid></parentcmid>\n        <modname></modname>\n      </section>\n`;
    }
    let contActivities = '';
    for (const a of mbzActivities) {
      contActivities += `      <activity>\n        <moduleid>${a.mid}</moduleid>\n        <sectionid>${a.secnum}</sectionid>\n        <modulename>${a.modname}</modulename>\n        <title>${esc(a.title)}</title>\n        <directory>${a.dir}</directory>\n        <insubsection></insubsection>\n      </activity>\n`;
    }

    let settXml = '';
    const rootSettings: Record<string, string> = {
      filename: esc(nombre) + '.mbz', users:'0', anonymize:'0', role_assignments:'0',
      activities:'1', blocks:'0', files:'1', filters:'1', comments:'0', badges:'0',
      calendarevents:'1', userscompletion:'0', logs:'0', grade_histories:'0',
      questionbank:'1', groups:'0', competencies:'0', customfield:'0',
      contentbankcontent:'0', xapistate:'0', legacyfiles:'1',
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
  <name>${esc(nombre)}</name>
  <moodle_version>${MV.mv}</moodle_version>
  <moodle_release>${MV.mr}</moodle_release>
  <backup_version>${MV.bv}</backup_version>
  <backup_release>${MV.br}</backup_release>
  <backup_date>${ts}</backup_date>
  <mnet_remoteusers>0</mnet_remoteusers>
  <include_files>1</include_files>
  <include_file_references_to_external_content>0</include_file_references_to_external_content>
  <original_wwwroot>https://campusvirtual.edu.co</original_wwwroot>
  <original_site_identifier_hash>7723815fd5e7880d12bcade15abbbfc8</original_site_identifier_hash>
  <original_course_id>1</original_course_id>
  <original_course_fullname>${esc(nombre)}</original_course_fullname>
  <original_course_shortname>${esc(nombre)}</original_course_shortname>
  <original_course_format>topics</original_course_format>
  <original_course_startdate>${ts}</original_course_startdate>
  <original_course_enddate>0</original_course_enddate>
  <original_course_contextid>1</original_course_contextid>
  <original_system_contextid>1</original_system_contextid>
  <details>
    <detail backup_id="cc${ts}">
      <type>course</type><format>moodle2</format><interactive>1</interactive>
      <mode>70</mode><execution>2</execution><executiontime>0</executiontime>
    </detail>
  </details>
  <contents>
    <activities>\n${contActivities}    </activities>
    <sections>\n${contSections}    </sections>
    <course>
      <courseid>1</courseid>
      <title>${esc(nombre)}</title>
      <directory>course</directory>
    </course>
  </contents>
  <settings>\n${settXml}  </settings>
</information>
</moodle_backup>`;
    zip.file('moodle_backup.xml', mbXml);

    // ── Generate ZIP ──────────────────────────────────────────────────────────

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    }) as unknown as Buffer;

    const safeName = nombre
      .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]/g, '')
      .replace(/\s+/g, '_');
    const filename = `${safeName}_moodle.mbz`;

    this.logger.log(`[MbzBuilder] Built ${filename}: ${buffer.length} bytes, ${mbzActivities.length} activities`);

    return {
      buffer,
      filename,
      sizeBytes:     buffer.length,
      activityCount: mbzActivities.length,
      hasMoodleBackupXml: true,
    };
  }
}
