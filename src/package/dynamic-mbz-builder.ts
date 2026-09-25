/**
 * Fase 5B.1 — B2 (PLACEHOLDER, bloque en paralelo).
 *
 * Stand-in mínimo de `buildDynamicMbz`, escrito por B3 solo para compilar y
 * probar la ejecución (worker + idempotencia + subida de artifact) mientras
 * B2 construye el builder real (spec §7, reutilizando piezas de
 * `mbz-builder.service.ts` con golden hash legacy). B2 reemplaza este
 * archivo entero al integrar — la firma exportada (`buildDynamicMbz`) es el
 * contrato compartido (`packaging-types.ts`).
 *
 * Este placeholder NO produce un `.mbz` restaurable en Moodle: solo un ZIP
 * determinístico (mismo input -> mismos bytes) con un `moodle_backup.xml`
 * mínimo que resume el plan, suficiente para probar la tubería de
 * ejecución/subida/idempotencia de B3 sin depender del builder real.
 */

import * as JSZip from 'jszip';
import type { BuildDynamicMbzInput } from '../modules/dynamic-packaging/packaging-types';

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function buildDynamicMbz(input: BuildDynamicMbzInput): Promise<Buffer> {
  const { plan, contents } = input;
  const zip = new JSZip();

  const activities: string[] = [];
  for (const m of plan.modules) {
    for (const c of m.chapters) {
      activities.push(`resource_${c.chapterId}`);
      if (c.videoItemKey) activities.push(`video_${c.chapterId}`);
      activities.push(`scorm_${c.chapterId}`);
    }
    if (m.examItemKey) activities.push(`quiz_${m.moduleId}`);
  }

  zip.file(
    'moodle_backup.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<moodle_backup planVersion="${plan.planVersion}" manifestId="${plan.manifestId ?? ''}">\n` +
      `  <course><title>${xmlEsc(plan.course.title)}</title></course>\n` +
      `  <activities count="${activities.length}">\n` +
      activities.map((a) => `    <activity>${xmlEsc(a)}</activity>\n`).join('') +
      `  </activities>\n` +
      `</moodle_backup>\n`,
  );

  for (const s of plan.sections) {
    const sequence =
      s.kind === 'module' ? plan.modules.find((m) => m.moduleId === s.moduleId)?.chapters.map((c) => c.chapterId) ?? [] : [];
    zip.file(
      `sections/section_${s.sectionNum}/section.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<section number="${s.sectionNum}" kind="${s.kind}">` +
        `<sequence>${xmlEsc(sequence.join(','))}</sequence></section>\n`,
    );
  }

  zip.file('resource/libro_guia.md', Array.from(contents.contentMd.entries()).map(([id, md]) => `<!-- ${id} -->\n${md}`).join('\n\n'));
  for (const [chapterId, scorm] of contents.scorm.entries()) {
    zip.file(`activities/scorm_${chapterId}/index.html`, scorm.html);
    zip.file(`activities/scorm_${chapterId}/imsmanifest.xml`, scorm.manifestXml);
  }
  for (const [moduleId, gift] of contents.examGift.entries()) {
    zip.file(`activities/quiz_${moduleId}/quiz.gift`, gift);
  }
  for (const [chapterId, video] of contents.videos.entries()) {
    zip.file(`activities/video_${chapterId}/video.json`, JSON.stringify({ url: video.url, videogenJobId: video.videogenJobId }));
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    // Determinístico: sin fecha en las entradas del ZIP.
    platform: 'UNIX',
  });
  return buffer;
}
