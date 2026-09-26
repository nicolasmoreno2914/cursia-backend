/* eslint-disable */
// R11a (Cursia V2.1) — fixtures del Course Shell: cursos de 2 y 4 módulos con
// las 4 combinaciones video/actividad, intros v3 válidas (salida simulada del
// LLM; sin LLM real), experiences (fixture de R2) y metadatos MEDIDOS de
// artifacts. Todo determinista.
'use strict';

const path = require('path');
const VCF = require('./v21-vc-fixtures');

function loadDist(distRoot, rel) {
  return require(path.join(distRoot, rel));
}

const uuid = (prefix, n) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, '0')}`;

const CHAPTER_TITLES = [
  'Fundamentos de la atención al cliente',
  'Escucha y empatía',
  'Comunicación clara',
  'Manejo de reclamos',
  'Negociación de acuerdos',
  'Seguimiento y fidelización',
  'Trabajo en equipo',
  'Calidad del servicio',
];
const MODULE_TITLES = ['Bases del servicio', 'Relación con el cliente', 'Gestión de conflictos', 'Mejora continua'];

/**
 * Curso: `modules` = [{ examEnabled, chapters: [{ video, activity }] }].
 * Devuelve { snapshot, manifest, source, ids }.
 */
function buildCourse(distRoot, { courseId = 501, title = 'Atención al cliente de excelencia', finalExam = true, engine = 'h5p', modules, chapterTitles = CHAPTER_TITLES, moduleTitles = MODULE_TITLES }) {
  const snap = loadDist(distRoot, 'modules/course-blueprints/blueprint-snapshot.js');
  const B = loadDist(distRoot, 'modules/generation-manifests/generation-manifest-builder.js');
  const mrows = [];
  const crows = [];
  let ci = 0;
  modules.forEach((m, mi) => {
    const mid = uuid('a', courseId * 10 + mi + 1);
    mrows.push({ id: mid, position: mi, title: moduleTitles[mi % moduleTitles.length], objective: null, exam_enabled: !!m.examEnabled });
    m.chapters.forEach((c, k) => {
      ci += 1;
      crows.push({
        id: uuid('c', courseId * 100 + ci),
        module_id: mid,
        position: k,
        title: chapterTitles[(ci - 1) % chapterTitles.length],
        objective: null,
        video_enabled: !!c.video,
        activity_enabled: !!c.activity,
      });
    });
  });
  const snapshot = snap.buildBlueprintSnapshotV2({ id: courseId, title, finalExam, activityEngine: engine }, mrows, crows);
  const source = { courseId, blueprintId: courseId + 7000, blueprintNumber: 1, blueprintSha256: snap.snapshotSha256V2(snapshot) };
  const manifest = B.buildGenerationManifestV3(snapshot, source);
  return { snapshot, manifest, source };
}

/** 2 módulos: M1 (examen) = [V+A, V−A]; M2 (sin examen) = [−V+A, −V−A]. */
function course2(distRoot, opts = {}) {
  return buildCourse(distRoot, {
    finalExam: true,
    ...opts,
    modules: [
      { examEnabled: true, chapters: [{ video: true, activity: true }, { video: true, activity: false }] },
      { examEnabled: false, chapters: [{ video: false, activity: true }, { video: false, activity: false }] },
    ],
  });
}

/** 4 módulos, 8 capítulos, las 4 combinaciones 2 veces; exámenes alternados. */
function course4(distRoot, opts = {}) {
  const combos = [
    { video: true, activity: true },
    { video: false, activity: true },
    { video: true, activity: false },
    { video: false, activity: false },
  ];
  return buildCourse(distRoot, {
    courseId: 502,
    finalExam: false,
    engine: 'scorm',
    ...opts,
    modules: [0, 1, 2, 3].map((mi) => ({
      examEnabled: mi % 2 === 0,
      chapters: [combos[mi % 4], combos[(mi + 1) % 4]],
    })),
  });
}

/** Sin videos ni actividades ni exámenes (curso mínimo). */
function courseBare(distRoot) {
  return buildCourse(distRoot, {
    courseId: 503,
    finalExam: false,
    modules: [{ examEnabled: false, chapters: [{ video: false, activity: false }, { video: false, activity: false }] }],
  });
}

/** Metadatos medidos (determinísticos) para cada capítulo/módulo del Manifest. */
function measuredArtifacts(manifest, { finalExamQuestionCount = 20 } = {}) {
  const chapters = manifest.modules.flatMap((m) => m.chapters);
  const slideCountByChapter = {};
  const audiobookParts = [];
  chapters.forEach((c, i) => {
    slideCountByChapter[c.chapterId] = 8 + (i % 3);
    audiobookParts.push({ chapterId: c.chapterId, seconds: 181.44 + 37 * i });
  });
  const examQuestionCountByModule = {};
  manifest.modules.forEach((m, i) => {
    if (m.examEnabled) examQuestionCountByModule[m.moduleId] = 12 + i;
  });
  const out = {
    audioWelcomeSeconds: 58.2,
    audiobookParts,
    slideCountByChapter,
    examQuestionCountByModule,
    libroWordCount: 18432,
  };
  if (manifest.features.finalExam) out.finalExamQuestionCount = finalExamQuestionCount;
  return out;
}

// ─── Intros v3 (salida simulada del LLM, sin cifras ni recursos) ────────────

const WELCOME =
  'Te damos la bienvenida a un recorrido pensado para quienes atienden personas todos los días. ' +
  'Aquí vas a fortalecer la forma en que escuchas, explicas y acompañas a cada cliente, desde el primer contacto hasta el seguimiento. ' +
  'Trabajaremos con situaciones reales del mostrador, del teléfono y de los canales digitales, para que cada idea tenga un uso concreto en tu jornada. ' +
  'Vas a descubrir por qué la empatía no es solo amabilidad, cómo ordenar una respuesta difícil y de qué manera un reclamo bien resuelto se convierte en confianza. ' +
  'Avanza a tu ritmo, vuelve sobre lo que necesites y anímate a probar cada técnica con tu propio equipo.';

function courseIntroFixture() {
  return {
    schemaVersion: 1,
    welcome: WELCOME,
    competencies: [
      'Escuchar de forma activa y confirmar lo que el cliente necesita.',
      'Explicar procesos y soluciones con un lenguaje claro y respetuoso.',
      'Resolver reclamos con un método ordenado y verificable.',
      'Construir acuerdos que el cliente perciba como justos.',
    ],
    methodology_note: 'Cada idea se conecta con situaciones cotidianas del servicio, para que puedas aplicarla desde el primer día.',
    closing:
      'Llegaste al final del recorrido con herramientas concretas para escuchar mejor, explicar con claridad y resolver con criterio. ' +
      'Sigue practicando con tu equipo y comparte lo que funcione en tu contexto.',
    bibliography: [
      { author: 'Zeithaml, V.', title: 'Calidad total en la gestión de servicios', year: 1993, publisher: 'Díaz de Santos' },
      { author: 'Albrecht, K.', title: 'La revolución del servicio', year: 1990, publisher: 'Legis' },
      { author: 'Barlow, J. y Moller, C.', title: 'Una queja es un favor', year: 2005, publisher: 'Gestión 2000' },
      { author: 'Fisher, R. y Ury, W.', title: 'Obtenga el sí', year: 2011, publisher: 'Gestión 2000' },
      { author: 'Goleman, D.', title: 'Inteligencia emocional', year: 1996, publisher: 'Kairós' },
    ],
  };
}

function moduleIntroFixture(manifest, moduleIndex0) {
  const m = manifest.modules[moduleIndex0];
  return {
    schemaVersion: 1,
    presentation:
      'En esta etapa vas a trabajar las bases que sostienen una buena experiencia de servicio. ' +
      'Partimos de cómo se forma la percepción del cliente y avanzamos hacia las conductas que la mejoran, con ejemplos del día a día y preguntas para tu propia práctica profesional.',
    outcomes: [
      'Reconocer los momentos que definen la experiencia del cliente.',
      'Aplicar técnicas de escucha en conversaciones reales.',
      'Ordenar una respuesta clara ante una consulta compleja.',
    ],
    journey: m.chapters.map((c) => ({ chapterId: c.chapterId, line: 'Un paso más en la forma de acompañar al cliente con criterio y calidez.' })),
    bibliography: [
      { author: 'Albrecht, K.', title: 'La revolución del servicio', year: 1990, publisher: 'Legis' },
      { author: 'Goleman, D.', title: 'Inteligencia emocional', year: 1996, publisher: 'Kairós' },
    ],
  };
}

function experienceFor(chapterId) {
  const e = VCF.buildExperience();
  e.chapterId = chapterId;
  return e;
}

function experiencesFor(manifest) {
  const out = {};
  for (const m of manifest.modules) for (const c of m.chapters) out[c.chapterId] = experienceFor(c.chapterId);
  return out;
}

// ─── Payloads h5p válidos (entrada de R7 sin itemKey/passPercentage) ───────

function h5pPayload(type) {
  if (type === 'questionset') {
    return {
      type,
      data: {
        title: 'Escucha activa',
        questions: [
          { kind: 'multichoice', question: '¿Qué muestra una escucha activa?', answers: [{ text: 'Parafrasear lo dicho', correct: true }, { text: 'Interrumpir para resolver rápido', correct: false }, { text: 'Mirar la pantalla', correct: false }] },
          { kind: 'truefalse', question: 'Confirmar lo entendido reduce malentendidos.', correct: true },
        ],
      },
    };
  }
  if (type === 'singlechoiceset') {
    return {
      type,
      data: {
        title: 'Comunicación clara',
        questions: [
          { question: '¿Qué frase es más clara?', answers: [{ text: 'Le envío el detalle hoy antes de las seis', correct: true }, { text: 'Veremos qué se puede hacer', correct: false }] },
          { question: '¿Qué evitar al explicar?', answers: [{ text: 'Tecnicismos sin aclarar', correct: true }, { text: 'Ejemplos concretos', correct: false }] },
        ],
      },
    };
  }
  if (type === 'dragtext') {
    return {
      type,
      data: {
        title: 'Manejo de reclamos',
        taskDescription: 'Arrastra cada palabra al lugar correcto.',
        text: 'Ante un reclamo primero *escuchamos* y luego *confirmamos* lo que entendimos.',
      },
    };
  }
  return {
    type,
    data: {
      title: 'Negociación',
      text: 'Completa las frases.',
      questions: ['Un buen acuerdo es *justo* para ambas partes.', 'Antes de proponer, conviene *preguntar* por las necesidades.'],
    },
  };
}

const FINAL_GIFT = Array.from({ length: 12 }, (_, i) =>
  `::P${i + 1}:: ¿Qué práctica mejora la atención al cliente en la situación ${String.fromCharCode(65 + i)}? {\n=Escuchar y confirmar lo entendido\n~Responder sin escuchar\n~Derivar sin explicar\n}`,
).join('\n\n');

module.exports = {
  loadDist,
  uuid,
  buildCourse,
  course2,
  course4,
  courseBare,
  measuredArtifacts,
  courseIntroFixture,
  moduleIntroFixture,
  experienceFor,
  experiencesFor,
  h5pPayload,
  FINAL_GIFT,
  THEME_COMBOS: VCF.THEME_COMBOS,
  themeLabel: VCF.themeLabel,
};
