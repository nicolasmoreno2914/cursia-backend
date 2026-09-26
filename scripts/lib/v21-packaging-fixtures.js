/* eslint-disable */
// Cursia V2.1 / R12 — fixtures del empaque v3: insumos COMPLETOS de
// buildDynamicMbzV3 a partir de los fixtures de R11a (curso de 2 módulos con
// las 4 combinaciones video/actividad), R8 (video_interactions), R10 (MP3
// reales recortados del V1) y medios sintéticos determinísticos. Sin LLM, sin
// proveedores, sin red. Todo determinista.
'use strict';

const path = require('path');
const fs = require('fs');
const SF = require('./v21-shell-fixtures');
const VF = require('./v21-video-fixture');

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');
const YOUTUBE_ID = 'IdwOipZAeqY';
const VIDEO_SECONDS = 468;

function contentMd(n, title) {
  return [
    `# Capítulo ${n}: ${title}`,
    '',
    `Este capítulo desarrolla **${title.toLowerCase()}** con ejemplos del servicio diario.`,
    '',
    '## Ideas clave',
    '',
    '- Escuchar antes de responder.',
    '- Confirmar lo entendido con palabras propias.',
    '- Cerrar con un próximo paso claro.',
    '',
    '| Situación | Respuesta recomendada |',
    '|---|---|',
    '| Cliente molesto | Reconocer la emoción y ofrecer una salida |',
    '| Consulta técnica | Explicar sin tecnicismos |',
    '',
    '> Una respuesta clara ahorra tres consultas posteriores.',
  ].join('\n');
}

const SCORM_MANIFEST = (n) => `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cap${n}_juego" version="1.2" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="cap${n}_org"><organization identifier="cap${n}_org"><title>Práctica del capítulo</title><item identifier="item_1" identifierref="resource_1"><title>Práctica</title></item></organization></organizations>
  <resources><resource identifier="resource_1" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources>
</manifest>`;

const SCORM_HTML = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Práctica</title></head><body><h1>Práctica</h1><p>Actividad de práctica (fixture).</p></body></html>';

function moduleGift(moduleNumber) {
  const mc = Array.from({ length: 6 }, (_, i) =>
    `::M${moduleNumber}P${i + 1}:: ¿Qué conducta mejora la atención en el caso ${String.fromCharCode(65 + i)}? {\n=Escuchar y confirmar\n~Interrumpir\n~Derivar sin explicar\n}`,
  );
  mc.push(`::M${moduleNumber}VF:: Confirmar lo entendido reduce malentendidos. {TRUE}`);
  mc.push(`::M${moduleNumber}REL:: Relaciona cada situación con su respuesta. {\n=Cliente molesto -> Reconocer la emoción\n=Consulta técnica -> Explicar sin tecnicismos\n=Reclamo resuelto -> Confirmar el cierre\n}`);
  return mc.join('\n\n');
}

/**
 * @param {string} distRoot
 * @param {{ engine?: 'h5p'|'scorm', finalExam?: boolean, theme?: {themeFamily:string, mode:string},
 *           profile?: object, mockPresentations?: boolean, realAudio?: boolean, coverSize?: [number, number] }} o
 */
function packagingInput(distRoot, o = {}) {
  const L = (rel) => SF.loadDist(distRoot, rel);
  const P = L('modules/course-profiles/course-profiles.js');
  const shell = L('modules/course-shell/index.js');
  const h5p = L('package/h5p/index.js');
  const media = L('package/v3/synthetic-media.js');
  const engine = o.engine || 'h5p';
  const finalExam = o.finalExam !== undefined ? o.finalExam : true;
  const { snapshot, manifest } = SF.course2(distRoot, { engine, finalExam, courseId: o.courseId || 601 });
  const chapters = manifest.modules.flatMap((m) => m.chapters);
  const titleOf = new Map();
  for (const m of snapshot.modules) for (const c of m.chapters) titleOf.set(c.id, c.title);
  const [cw, chh] = o.coverSize || [1600, 900];

  const presentations = new Map();
  const audiobookChapters = new Map();
  const contentMdMap = new Map();
  const videos = new Map();
  const videoInteractions = new Map();
  const activities = new Map();
  const slices = ['slice-a.mp3', 'slice-b.mp3', 'slice-c.mp3'];
  chapters.forEach((c, i) => {
    presentations.set(c.chapterId, {
      pdf: media.syntheticPdf(8 + (i % 3)),
      cover: media.syntheticCoverPng(cw, chh, ['#2F5D8A', '#3A7D44', '#8A3A5D', '#6B5B2A'][i % 4]),
      ...(o.mockPresentations ? { mock: true } : {}),
    });
    audiobookChapters.set(
      c.chapterId,
      o.realAudio ? fs.readFileSync(path.join(FIXTURES, slices[i % slices.length])) : media.syntheticMp3(150 + 17 * i),
    );
    contentMdMap.set(c.chapterId, contentMd(c.chapterNumber, titleOf.get(c.chapterId)));
    if (c.videoEnabled) {
      const key = `video:${c.chapterId}`;
      videos.set(c.chapterId, { youtubeId: YOUTUBE_ID, durationSec: VIDEO_SECONDS });
      videoInteractions.set(c.chapterId, VF.makeInteractionsDoc(h5p.planInteractionCheckpoints(VIDEO_SECONDS), { videoItemKey: key, durationSec: VIDEO_SECONDS }));
    }
    if (c.activityEnabled) {
      if (engine === 'h5p') {
        const payload = SF.h5pPayload(shell.activityTypeForChapter(c.chapterId));
        payload.data.itemKey = `activity:${c.chapterId}`;
        if (payload.type === 'questionset') payload.data.passPercentage = 70; // el empaque lo reemplaza por el perfil
        activities.set(c.chapterId, { variant: 'h5p', payload });
      } else {
        activities.set(c.chapterId, { variant: 'scorm', html: SCORM_HTML, manifestXml: SCORM_MANIFEST(c.chapterNumber) });
      }
    }
  });
  const moduleIntros = new Map();
  const examGift = new Map();
  manifest.modules.forEach((m, mi) => {
    moduleIntros.set(m.moduleId, SF.moduleIntroFixture(manifest, mi));
    if (m.examEnabled) examGift.set(m.moduleId, moduleGift(m.moduleNumber));
  });
  const experiences = new Map(Object.entries(SF.experiencesFor(manifest)));
  const welcome = o.realAudio ? fs.readFileSync(path.join(FIXTURES, 'welcome-100f.mp3')) : media.syntheticMp3(58.2);

  const profile = o.profile || P.defaultAssessmentProfile({ finalExam });
  return {
    manifest,
    blueprint: snapshot,
    manifestId: 9001,
    assessmentProfile: profile,
    presentation: o.theme ? { themeFamily: o.theme.themeFamily, mode: o.theme.mode } : { themeFamily: 'aula-clara', mode: 'light' },
    ts: 1790500000,
    moodleVersion: o.moodleVersion,
    contents: {
      courseIntro: SF.courseIntroFixture(),
      moduleIntros,
      contentMd: contentMdMap,
      experiences,
      presentations,
      videos,
      videoInteractions,
      activities,
      examGift,
      finalExamGift: finalExam ? SF.FINAL_GIFT : null,
      audioWelcome: welcome,
      audiobookChapters,
    },
  };
}

/** Secuencia esperada de idnumbers `cv3:…` por sección, derivada SOLO del Manifest + chapterSlotSequence (R11a). */
function expectedSequence(distRoot, input) {
  const SHELL = SF.loadDist(distRoot, 'modules/course-shell/index.js');
  const m = input.manifest;
  const seq = [];
  seq.push([0, ['cv3:shell:forum', 'cv3:shell:welcome', 'cv3:shell:audio_welcome', 'cv3:shell:competencies', 'cv3:shell:methodology']]);
  seq.push([1, ['cv3:shell:route', 'cv3:shell:libro', 'cv3:shell:libro_card', 'cv3:shell:audiobook']]);
  for (const mod of m.modules) {
    const ids = [`cv3:module_intro:${mod.moduleId}`];
    for (const ch of mod.chapters) {
      for (const s of SHELL.chapterSlotSequence({ videoEnabled: ch.videoEnabled, activityEnabled: ch.activityEnabled })) {
        const role = s.startsWith('label:') ? s.slice(6) : s === 'video_h5p' ? 'video' : s;
        ids.push(`cv3:ch:${ch.chapterId}:${role}`);
      }
    }
    if (mod.examEnabled) ids.push(`cv3:exam_info:${mod.moduleId}`, `cv3:exam:${mod.moduleId}`);
    seq.push([1 + mod.moduleNumber, ids]);
  }
  const closing = ['cv3:shell:closing'];
  if (m.features.finalExam) closing.push('cv3:final_exam_info', 'cv3:final_exam');
  seq.push([2 + m.modules.length, closing]);
  return seq;
}

module.exports = { packagingInput, expectedSequence, contentMd, moduleGift, SCORM_HTML, SCORM_MANIFEST, YOUTUBE_ID, VIDEO_SECONDS };
