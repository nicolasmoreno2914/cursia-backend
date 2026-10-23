/**
 * mbz-common.ts
 *
 * Piezas genéricas del builder legacy (`mbz-builder.service.ts`), copiadas
 * verbatim (o con una firma ligeramente adaptada para no depender de closures
 * mutables compartidas) para reutilizarlas en `dynamic-mbz-builder.ts` (Fase
 * 5B.1) SIN tocar el archivo legacy — ver CLAUDE.md / spec 5B §2.1
 * ("Legacy intocable").
 *
 * Cada función indica la línea de origen en mbz-builder.service.ts al momento
 * de la copia (commit c1733ae y anteriores). Si el legacy cambia estas
 * piezas después, este archivo puede quedar desactualizado — no es un
 * problema mientras el legacy siga produciendo el mismo .mbz byte a byte
 * (verificado aparte con golden hash si alguna vez se re-extrae desde ahí).
 */

import * as JSZip from 'jszip';
import { createHash } from 'crypto';

// ─── Moodle version table (mbz-builder.service.ts:87-95) ──────────────────

export interface MoodleVersionInfo { mv: string; mr: string; bv: string; br: string }

export const MOODLE_VERSIONS: Record<string, MoodleVersionInfo> = {
  '4.5': { mv: '2024100710', mr: '4.5.10 (Build: 20260216)', bv: '2024100700', br: '4.5' },
  '4.4': { mv: '2024042200', mr: '4.4 (Build: 20240422)', bv: '2024042200', br: '4.4' },
  '4.1': { mv: '2022112800', mr: '4.1 (Build: 20221128)', bv: '2022112800', br: '4.1' },
  '4.0': { mv: '2022041900', mr: '4.0 (Build: 20220419)', bv: '2022041900', br: '4.0' },
  '3.11': { mv: '2021051700', mr: '3.11 (Build: 20210517)', bv: '2021051700', br: '3.11' },
  '3.9': { mv: '2020061500', mr: '3.9 (Build: 20200615)', bv: '2020061500', br: '3.9' },
};

export function resolveMoodleVersion(v?: string): MoodleVersionInfo {
  return MOODLE_VERSIONS[v ?? '4.1'] ?? MOODLE_VERSIONS['4.1'];
}

// ─── Pure helpers (mbz-builder.service.ts:114-171) ─────────────────────────

export function sha1Buf(data: Buffer | Uint8Array | string): string {
  const h = createHash('sha1');
  if (typeof data === 'string') h.update(data, 'utf8');
  else h.update(data);
  return h.digest('hex');
}

export function textBytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Escapa para atributos/contenido de nodo "normal" (sí escapa apóstrofes). mbz-builder.service.ts:125-130 */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * xmlEsc "real" — solo escapa &,<,>," (NO apóstrofes). mbz-builder.service.ts:132-136.
 * Documentado en CLAUDE.md: cualquier reconstrucción manual de XML debe igualar esto
 * exactamente para no corromper el HTML embebido.
 */
export function xmlEsc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** mbz-builder.service.ts:145-151 */
export function safeActivityName(name: string, max = 240): string {
  if (!name || name.length <= max) return name;
  let cut = name.substring(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) cut = cut.substring(0, lastSpace);
  return cut.replace(/[\s—\-:,]+$/, '') + '…';
}

// ─── XML templates (mbz-builder.service.ts:184-333) ────────────────────────
// Adaptadas para recibir `ts` (timestamp) y `bv` (backup_version) por parámetro
// en vez de leerlos de una closure — el resto es idéntico byte a byte.

export function moduleXml(mid: number, modname: string, secnum: number, ts: number, bv: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<module id="${mid}" version="${bv}">
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

export function labelXmlWithCtx(aid: number, mid: number, ctx: number, name: string, content: string, ts: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${aid}" moduleid="${mid}" modulename="label" contextid="${ctx}">
  <label id="${aid}">
    <name>${xmlEsc(name)}</name>
    <intro>${xmlEsc(content)}</intro>
    <introformat>1</introformat>
    <timemodified>${ts}</timemodified>
  </label>
</activity>`;
}

export function inforefXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n</inforef>`;
}

export function inforefXmlWithFiles(fileIds: number[]): string {
  if (!fileIds.length) return inforefXml();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<inforef>\n  <fileref>\n${fileIds.map((id) => `    <file><id>${id}</id></file>`).join('\n')}\n  </fileref>\n</inforef>`;
}

export function gradesXml(_aid: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity_gradebook>
  <grade_items>
  </grade_items>
  <grade_letters>
  </grade_letters>
</activity_gradebook>`;
}

export function forumXml(aid: number, mid: number, ctx: number, name: string, ts: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${aid}" moduleid="${mid}" modulename="forum" contextid="${ctx}">
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

export interface SectionMeta { num: number; name: string; summary: string }

export function sectionXml(sec: SectionMeta, seqStr: string, ts: number): string {
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

/** mbz-builder.service.ts:480-489 — escribe los 8 XML boilerplate comunes a toda actividad. */
export function writeActFiles(zip: JSZip, d: string): void {
  zip.file(d + '/roles.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<roles>\n  <role_overrides>\n  </role_overrides>\n  <role_assignments>\n  </role_assignments>\n</roles>');
  zip.file(d + '/calendar.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n</events>');
  zip.file(d + '/grade_history.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<grade_history>\n  <grade_grades>\n  </grade_grades>\n</grade_history>');
  zip.file(d + '/competencies.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<course_module_competencies>\n  <competencies>\n  </competencies>\n</course_module_competencies>');
  zip.file(d + '/filters.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<filters>\n  <filter_actives>\n  </filter_actives>\n  <filter_configs>\n  </filter_configs>\n</filters>');
  zip.file(d + '/completion.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<completions>\n  <completionviews>\n  </completionviews>\n</completions>');
  zip.file(d + '/comments.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<comments>\n</comments>');
  zip.file(d + '/xapistate.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<xapistate>\n</xapistate>');
}

// ─── GIFT parser (mbz-builder.service.ts:492-583, "identical to 08-downloads.js") ──

export type GiftQuestion =
  | { type: 'match'; name: string; text: string; pairs: Array<{ q: string; a: string }> }
  | { type: 'truefalse'; name: string; text: string; answer: boolean }
  | { type: 'shortanswer'; name: string; text: string; answers: string[] }
  | { type: 'multichoice'; name: string; text: string; options: Array<{ text: string; correct: boolean }> };

export function parseGIFT(gift: string): GiftQuestion[] {
  const questions: GiftQuestion[] = [];
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
    fullLine = fullLine.replace(/\{\{+/g, '{').replace(/\}\}+/g, '}');
    const braceStart = fullLine.indexOf('{');
    const braceEnd = fullLine.lastIndexOf('}');
    if (braceStart < 0 || braceEnd < 0) { i++; continue; }
    let qText = fullLine.substring(0, braceStart).trim();
    const qTextAfter = fullLine.substring(braceEnd + 1).trim();
    if (!qText && name) qText = name;
    const ansBlock = fullLine.substring(braceStart + 1, braceEnd).trim();
    const ansBlockArrows = ansBlock.replace(/→|⟶|-{1,2}>/g, '->');

    if (ansBlockArrows.indexOf('->') >= 0) {
      const pairs: Array<{ q: string; a: string }> = [];
      for (const ml of ansBlockArrows.split('\n')) {
        const m = ml.trim();
        if (m.charAt(0) === '=') {
          const parts = m.substring(1).split('->');
          if (parts.length >= 2) pairs.push({ q: parts[0].trim(), a: parts.slice(1).join('->').trim() });
        }
      }
      if (pairs.length) questions.push({ type: 'match', name, text: qText, pairs });
    } else if (['TRUE', 'FALSE', 'T', 'F', 'VERDADERO', 'FALSO'].includes(ansBlock)) {
      questions.push({ type: 'truefalse', name, text: qText, answer: ['TRUE', 'T', 'VERDADERO'].includes(ansBlock) });
    } else if (/^#/.test(ansBlock)) {
      const numMatch = ansBlock.match(/^#\s*([\d.\-]+)/);
      if (numMatch) questions.push({ type: 'shortanswer', name, text: qText, answers: [numMatch[1]] });
    } else if (ansBlock.indexOf('~') >= 0 || ansBlock.indexOf('=') === 0) {
      if (ansBlock.indexOf('~') < 0) {
        const braceGroups: Array<{ start: number; end: number; inner: string }> = [];
        const bgRe = /\{([^{}]*)\}/g;
        let bgm: RegExpExecArray | null;
        while ((bgm = bgRe.exec(fullLine))) braceGroups.push({ start: bgm.index, end: bgRe.lastIndex, inner: bgm[1] });
        if (braceGroups.length > 1) {
          let rebuilt = '', cursor = 0, firstAnswers: string[] | null = null;
          for (let gi = 0; gi < braceGroups.length; gi++) {
            const g = braceGroups[gi];
            rebuilt += fullLine.substring(cursor, g.start);
            const alts = g.inner.split('=').map((s) => s.trim()).filter((s) => s.length > 0);
            if (gi === 0) { rebuilt += '_____'; firstAnswers = alts; }
            else { rebuilt += (alts[0] || ''); }
            cursor = g.end;
          }
          rebuilt += fullLine.substring(cursor);
          if (firstAnswers && firstAnswers.length) questions.push({ type: 'shortanswer', name, text: rebuilt.trim(), answers: firstAnswers });
        } else {
          if (qTextAfter) qText = (qText + ' _____ ' + qTextAfter).trim();
          const saAnswers = ansBlock.split('=').map((l) => l.trim().replace(/\}+$/, '')).filter((l) => l.length > 0);
          if (saAnswers.length) questions.push({ type: 'shortanswer', name, text: qText, answers: saAnswers });
        }
      } else {
        const opts: Array<{ text: string; correct: boolean }> = [];
        for (const ol of ansBlock.split('\n')) {
          const o = ol.trim(); if (!o) continue;
          if (o.charAt(0) === '=') { opts.push({ text: o.substring(1).trim(), correct: true }); }
          else if (o.charAt(0) === '~') { opts.push({ text: o.substring(1).trim().replace(/^%[-\d]+%\s*/, ''), correct: false }); }
        }
        if (opts.length) questions.push({ type: 'multichoice', name, text: qText, options: opts });
      }
    } else if (ansBlock.length > 0 && ansBlock.indexOf('\n') < 0 && ansBlock.length < 150) {
      if (qTextAfter) qText = (qText + ' _____ ' + qTextAfter).trim();
      questions.push({ type: 'shortanswer', name, text: qText, answers: [ansBlock] });
    }
    i++;
  }
  return questions;
}

export function defMf(cap: { n: string | number; t: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cap${cap.n}_juego" version="1.2" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="cap${cap.n}_org"><organization identifier="cap${cap.n}_org"><title>Cap ${cap.n}: ${cap.t}</title><item identifier="item_1" identifierref="resource_1"><title>Juego Cap ${cap.n}</title></item></organization></organizations>
  <resources><resource identifier="resource_1" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources>
</manifest>`;
}
