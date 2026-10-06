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
  // F1: `o.modules` (forma de SF.buildCourse) permite cursos a medida (sin exámenes, sin práctica…).
  // EV5-C: `o.activityTypeRules` / `o.chapterObjectives` → Manifest con h5pType por objetivo.
  const ev5c = {
    ...(o.activityTypeRules ? { activityTypeRules: o.activityTypeRules } : {}),
    ...(o.chapterObjectives ? { chapterObjectives: o.chapterObjectives } : {}),
    // EV6 H5P v2: ajuste «Repaso» del Blueprint.
    ...(o.reviewCards ? { reviewCards: true } : {}),
  };
  const { snapshot, manifest } = o.modules
    ? SF.buildCourse(distRoot, { engine, finalExam, courseId: o.courseId || 601, modules: o.modules, ...(o.chapterTitles ? { chapterTitles: o.chapterTitles } : {}), ...ev5c })
    : SF.course2(distRoot, { engine, finalExam, courseId: o.courseId || 601, ...ev5c });
  const itemByKey = new Map(manifest.items.map((i) => [i.key, i]));
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
  // Fase 2: documento de prueba de cada Actividad de Aplicación (salida simulada del ejecutor; valida contra el contrato).
  const applications = new Map();
  for (const c of chapters) if (c.applicationMinutes !== undefined) applications.set(c.chapterId, applicationDoc(c.chapterId, c.applicationMinutes, c.chapterNumber));
  chapters.forEach((c, i) => {
    if (c.kind === 'practice') {
      // Motor de carga horaria: el capítulo de práctica no tiene presentación, Libro (content) ni audiolibro.
      if (c.activityEnabled) {
        if (engine === 'h5p') {
          const payload = SF.h5pPayload(shell.resolveActivityType(itemByKey.get(`activity:${c.chapterId}`), { activityTypeRules: manifest.features && manifest.features.activityTypeRules }));
          payload.data.itemKey = `activity:${c.chapterId}`;
          if (payload.type === 'questionset') payload.data.passPercentage = 70;
          activities.set(c.chapterId, { variant: 'h5p', payload });
        } else {
          activities.set(c.chapterId, { variant: 'scorm', html: SCORM_HTML, manifestXml: SCORM_MANIFEST(c.chapterNumber) });
        }
      }
      return;
    }
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
      const doc = VF.makeInteractionsDoc(h5p.planInteractionCheckpoints(VIDEO_SECONDS), { videoItemKey: key, durationSec: VIDEO_SECONDS });
      if (manifest.features && manifest.features.ivAdvanced === 1) {
        // EV6 IV avanzado: schemaVersion 2 con las pausas del plan (salida simulada del LLM).
        doc.schemaVersion = 2;
        doc.reflections = h5p.planReflectionPauses(VIDEO_SECONDS, h5p.planInteractionCheckpoints(VIDEO_SECONDS)).reflections.map((r) => ({
          index: r.index,
          prompt: '¿Cómo aplicarías lo que acabas de ver con un cliente real?',
          hint: 'Piensa en tu último reclamo.',
        }));
      }
      videoInteractions.set(c.chapterId, doc);
    }
    if (c.activityEnabled) {
      if (engine === 'h5p') {
        // EV5-C: el tipo que produciría el ejecutor = resolveActivityType(item del Manifest).
        const payload = SF.h5pPayload(shell.resolveActivityType(itemByKey.get(`activity:${c.chapterId}`), { activityTypeRules: manifest.features && manifest.features.activityTypeRules }));
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
      ...(applications.size ? { applications } : {}),
    },
  };
}

/** Fase 2: documento `dynamic_application_json` de prueba (cantidades según el nivel de minutos). */
function applicationDoc(chapterId, minutes, n) {
  const count = { 30: 6, 60: 7, 90: 9, 120: 10 }[minutes];
  const diff = (i) => (i < 2 ? 'basico' : i < count - 2 ? 'intermedio' : 'avanzado');
  const split = { 30: [5, 15, 8, 2], 60: [10, 30, 15, 5], 90: [15, 45, 25, 5], 120: [20, 60, 35, 5] }[minutes];
  const activity = {
    genre: 'case_analysis',
    title: `Aplica el capítulo ${n} en un caso real`,
    objective: 'Analizar una situación de atención al cliente y proponer una respuesta fundamentada.',
    context: 'Trabajas en el área de servicio de una empresa de la región y recibes casos que exigen aplicar lo aprendido en el capítulo.',
    examples: [{ title: 'Caso resuelto', problem: 'Un cliente reclama por una entrega tardía y pide la devolución del dinero.', steps: ['Escucha y resume el reclamo.', 'Propón una solución dentro de la política.'], result: 'El cliente acepta un reenvío sin costo.' }],
    exercises: Array.from({ length: count }, (_, i) => ({ id: `E${i + 1}`, prompt: `Analiza el caso hipotético ${i + 1} y explica qué harías.`, difficulty: diff(i), answerLines: 3 })),
    workshop: { title: 'Taller del capítulo', situation: 'Atiendes una jornada con varios casos hipotéticos de clientes y debes priorizar y responder cada uno.', instructions: ['Prioriza los casos.', 'Redacta la respuesta de los dos más urgentes.'] },
    deliverable: { description: 'Un documento con la priorización y las respuestas.', format: 'Documento', extent: 'Una página' },
    selfCheck: ['¿Escuché el reclamo completo?', '¿Mi solución está dentro de la política?', '¿Expliqué el porqué?', '¿Usé un tono cordial?'],
    criteria: [{ name: 'Análisis del caso', description: 'Identifica el problema real.', weight: 40 }, { name: 'Solución', description: 'Propone una solución viable.', weight: 40 }, { name: 'Comunicación', description: 'Responde con claridad y cordialidad.', weight: 20 }],
    minutesBySection: { examples: split[0], exercises: split[1], workshop: split[2], selfCheck: split[3] },
  };
  const solution = {
    answers: activity.exercises.map((e) => ({ exerciseId: e.id, answer: `Respuesta esperada del ${e.id}.`, explanation: 'Se identifica el problema y se propone una solución dentro de la política.' })),
    workshopSolution: 'Un buen trabajo prioriza por urgencia e impacto, responde con empatía y deja registro de cada caso atendido en la jornada.',
    correctionGuide: activity.criteria.map((c) => ({ criterion: c.name, achieved: 'Cumple el criterio por completo.', developing: 'Cumple el criterio en parte.', insufficient: 'No cumple el criterio.' })),
    teacherNotes: ['Acepta soluciones alternativas si respetan la política.'],
  };
  return { schemaVersion: 1, chapterId, minutes, activity, solution };
}

/**
 * Secuencia esperada de idnumbers `cv3:…` por sección, derivada SOLO del Manifest + chapterSlotSequence (R11a).
 * EV6 (derivación independiente de section-layout.ts): 0 bienvenida, 1 ruta; por módulo una sección por
 * capítulo (la presentación del módulo arriba del primero) y, si tiene examen, «Módulo m · Evaluación»
 * (info + quiz + «Respuestas explicadas» (P2-B4) + siguiente paso; sin examen NO hay label de siguiente paso: el botón del cierre de su
 * último capítulo lo es — fix 1, I1); después la
 * evaluación final (si hay: info + quiz + botón al cierre) y, ÚLTIMA, el cierre del curso.
 */
function expectedSequence(distRoot, input) {
  const SHELL = SF.loadDist(distRoot, 'modules/course-shell/index.js');
  const H5P = SF.loadDist(distRoot, 'package/h5p/index.js');
  const m = input.manifest;
  // EV6 H5P v2: «Repaso» iff ajuste del Blueprint + experiencia con ≥ 4 tarjetas.
  const reviewOn = !!(input.blueprint && input.blueprint.course && input.blueprint.course.reviewCards === true);
  const hasReview = (chapterId) => reviewOn && !!H5P.buildDialogCardsFromExperience({ chapterTitle: 'x', experience: input.contents.experiences.get(chapterId) });
  const seq = [];
  // UX r18 (problema 1): el hero de bienvenida abre la sección 0 (justo bajo el encabezado de Moodle); el foro la cierra.
  seq.push([0, ['cv3:shell:welcome', 'cv3:shell:audio_welcome', 'cv3:shell:competencies', 'cv3:shell:methodology', 'cv3:shell:start', 'cv3:shell:forum']]);
  // #583 (builder 3.11.0): la tarjeta del Libro Guía es la descripción del recurso (sin label cv3:shell:libro_card).
  seq.push([1, ['cv3:shell:route', 'cv3:shell:libro', 'cv3:shell:audiobook', 'cv3:shell:route_start']]);
  let n = 2;
  // EV6 P2-B4: sin certificado (= sin evaluación final) la nota oculta para docentes de «Respuestas
  // explicadas» abre la PRIMERA sección de evaluación; cada quiz lleva su página justo después.
  let teacherNote = !m.features.finalExam;
  for (const mod of m.modules) {
    mod.chapters.forEach((ch, i) => {
      const ids = i === 0 ? [`cv3:module_intro:${mod.moduleId}`] : [];
      for (const s of SHELL.chapterSlotSequence({ videoEnabled: ch.videoEnabled, activityEnabled: ch.activityEnabled, reviewCards: hasReview(ch.chapterId), practice: ch.kind === 'practice', application: ch.applicationMinutes !== undefined })) {
        const role = s.startsWith('label:') ? s.slice(6) : s === 'video_h5p' ? 'video' : s;
        ids.push(`cv3:ch:${ch.chapterId}:${role}`);
      }
      seq.push([n++, ids]);
    });
    // Edu EV3: la evaluación del módulo cierra con el botón al módulo siguiente (o a la evaluación final / cierre).
    if (mod.examEnabled) {
      const ids = [`cv3:exam_info:${mod.moduleId}`, `cv3:exam:${mod.moduleId}`, `cv3:exam_explanations:${mod.moduleId}`, `cv3:module_next:${mod.moduleId}`];
      if (teacherNote) ids.unshift('cv3:shell:exams_teacher');
      teacherNote = false;
      seq.push([n++, ids]);
    }
  }
  if (m.features.finalExam) seq.push([n++, ['cv3:final_exam_info', 'cv3:final_exam', 'cv3:final_exam_explanations', 'cv3:final_exam_next']]);
  // EV6 T3 fix 0b: + label oculto para docentes (activar la insignia-certificado); fix round 1b:
  // el certificado existe SOLO con evaluación final.
  seq.push([n, m.features.finalExam ? ['cv3:shell:closing', 'cv3:shell:certificate_teacher'] : ['cv3:shell:closing']]);
  return seq;
}

module.exports = { packagingInput, expectedSequence, applicationDoc, contentMd, moduleGift, SCORM_HTML, SCORM_MANIFEST, YOUTUBE_ID, VIDEO_SECONDS };
