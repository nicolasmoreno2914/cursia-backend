/* eslint-disable */
// r77 — «Mobile-first»: cursos SINTÉTICOS representativos para medir los materiales de Cursia en teléfonos.
// Sin IA, sin red, USD 0. Todo determinista.
//
// Un curso por estilo (7 estilos del Theme Engine) + uno con marca propia (color, logo, serif, nombre largo):
//   - 2 módulos; M1 con evaluación: cap. 1 con video interactivo H5P + actividad H5P + Actividad de Aplicación +
//     práctica guiada; cap. 2 con actividad H5P; M2 sin evaluación: cap. 3 sin video ni actividad.
//   - «Repaso» (Dialog Cards, H5P solo contenido), evaluación final + insignia/certificado, Guía del docente.
//   - Lecciones con TODOS los componentes visuales (incluida la comparación de 4 columnas = tabla ancha), con
//     palabras largas y URLs largas sin espacios en títulos y cuerpos (estrés de desborde).
//   - Portadas de presentación 1600 × 900 (imagen de Gamma sintética), Libro Guía en PDF, audiolibro EN LÍNEA (r74,
//     reproductores con direcciones duraderas) y audio de bienvenida embebido.
// Los textos largos son VÁLIDOS para el validador del empaque (el contenido pedagógico es el de los fixtures de siempre;
// solo se agregan una palabra larga y una dirección larga, como las que escribe un docente real).
'use strict';

const path = require('path');
const SF = require('./v21-shell-fixtures');
const V = require('./v21-packaging-fixtures');
const MEDIA_BASE = 'https://api-staging.cursia.nomaddi.com';

const STYLES = [
  { key: 'aula-clara', label: 'Aula Clara', profile: { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 } },
  { key: 'institucional', label: 'Institucional', profile: { themeFamily: 'institucional', mode: 'light', brandSeed: null, themeVersion: 1 } },
  { key: 'editorial', label: 'Editorial', profile: { themeFamily: 'editorial', mode: 'light', brandSeed: null, themeVersion: 1 } },
  { key: 'tecnico-claro', label: 'Técnico claro', profile: { themeFamily: 'tecnico', mode: 'light', brandSeed: null, themeVersion: 1 } },
  { key: 'tecnico-oscuro', label: 'Técnico oscuro', profile: { themeFamily: 'tecnico', mode: 'dark', brandSeed: null, themeVersion: 1 } },
  { key: 'vibrante', label: 'Vibrante', profile: { themeFamily: 'vibrante', mode: 'light', brandSeed: null, themeVersion: 1 } },
  { key: 'oscuro-premium', label: 'Oscuro Premium', profile: { themeFamily: 'oscuro-premium', mode: 'dark', brandSeed: null, themeVersion: 1 } },
];

/** Logo de prueba PNG 240 × 90 (mismo dibujo que r76). */
function testLogoPng(MEDIA, hex = '#0B6E4F') {
  const w = 240, h = 90;
  const px = Buffer.alloc(w * h * 4);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = (x > 10 && x < 80 && y > 10 && y < 80) || (y > 35 && y < 55 && x > 90 && x < 230);
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = inside ? 255 : 0;
  }
  return MEDIA.encodePng(w, h, 4, px);
}

function customStyle(MEDIA) {
  const logo = `data:image/png;base64,${testLogoPng(MEDIA).toString('base64')}`;
  return {
    key: 'marca-propia',
    label: 'Marca propia (Vibrante + #0B6E4F + serif + logo)',
    profile: {
      themeFamily: 'vibrante', mode: 'light', brandSeed: { accent: '#0B6E4F', moduleColors: ['#0B6E4F', '#7A1F5C'] }, themeVersion: 1, typography: 'serif',
      identity: { logo: 'custom', logoDataUri: logo, institutionName: 'Institución Universitaria de Formación Técnica Profesional del Caribe', watermark: true, showInCourse: true },
    },
  };
}

// Estrés realista: una palabra larga del área y una dirección larga sin espacios (como las pega un docente).
const LONG_WORD = 'Interdepartamentalmente';
const LONG_URL = 'https://www.institucion-ejemplo.edu.co/recursos/atencion-al-cliente/protocolos/guia-de-escucha-activa-2026.pdf';

function stressExperience(e) {
  const x = JSON.parse(JSON.stringify(e));
  const all = Object.values(x.movements).flat();
  const hero = all.find((c) => c.type === 'hero');
  if (hero) hero.title = `${hero.title.replace(/\.$/, '')}: ${LONG_WORD}`.slice(0, 90);
  const callout = all.find((c) => c.type === 'callout');
  if (callout) callout.body = `${callout.body} Consulta el protocolo en ${LONG_URL}`;
  const cards = all.find((c) => c.type === 'concept_cards');
  if (cards && cards.cards[0]) cards.cards[0].term = `Coordinación ${LONG_WORD.toLowerCase()}`;
  return x;
}

const CHAPTER_TITLES = [
  'Fundamentos de la atención al cliente omnicanal y sus responsabilidades interdepartamentales',
  'Escucha activa',
  'Manejo de reclamos',
];

/**
 * Insumos de buildDynamicMbzV3 para el curso r77 con el perfil de presentación dado.
 * @param {string} dist  dist del backend
 * @param {object} profile  perfil de presentación (normalizado o no)
 * @param {{ linkedAudio?: boolean }} o
 */
function mobileCourseInput(dist, profile, o = {}) {
  const L = (r) => require(path.join(dist, r));
  const P = L('modules/course-profiles/course-profiles.js');
  const PK = L('modules/dynamic-packaging/packaging-v3.js');
  const SD = L('modules/dynamic-packaging/split-delivery-v3.js');
  const DP = L('package/v3/delivery-plan.js');
  const crypto = require('crypto');
  const { snapshot, manifest } = SF.buildCourse(dist, {
    courseId: 7701,
    title: 'Atención integral al cliente en entornos omnicanal',
    finalExam: true,
    engine: 'h5p',
    reviewCards: true,
    activityTypeRules: 2,
    chapterTitles: CHAPTER_TITLES,
    modules: [
      { examEnabled: true, chapters: [{ video: true, activity: true, application: 60, guided: 60 }, { video: false, activity: true }] },
      { examEnabled: false, chapters: [{ video: false, activity: false }] },
    ],
  });
  const assessment = { ...P.defaultAssessmentProfile({ finalExam: true }), teacherGuide: { include: true } };
  const norm = P.normalizePresentationProfile(profile);
  const theme = PK.resolvePackagingTheme({ presentationProfile: norm }).input;
  const input = V.packagingInput(dist, { snapshot, manifest, engine: 'h5p', reviewCards: true, profile: assessment });
  input.presentation = theme;
  for (const [id, e] of input.contents.experiences) input.contents.experiences.set(id, stressExperience(e));
  const brand = PK.applyPresentationIdentity({ logo: null, candidates: [], name: null, warnings: [] }, P.presentationIdentityOf(norm));
  input.libroBrand = {
    logo: brand.candidates, name: brand.name,
    ...(brand.watermark === false ? { watermark: false } : {}), ...(brand.showInCourse ? { showInCourse: true } : {}),
  };
  if (o.linkedAudio !== false) {
    const plan = DP.planAudioParts(SD.audioChapterSizes(input), { partMaxBytes: 200 * 1024 * 1024, maxParts: 20 });
    if (!plan.ok) throw new Error(`plan de audio: ${plan.reason}`);
    const links = {};
    let n = 0;
    for (const sg of SD.audiobookSegmentsOf(input, plan.parts)) {
      n += 1;
      const id = `00000000-0000-4000-8000-${String(770000000000 + n)}`;
      const key = crypto.createHash('sha256').update(`r77-${sg.key}`).digest('hex');
      links[sg.key] = `${MEDIA_BASE}/api/v1/media/${id}/${key}/${sg.file}`;
    }
    input.audiobookDelivery = { mode: 'linked', parts: plan.parts, links };
  }
  return input;
}

module.exports = { STYLES, customStyle, mobileCourseInput, stressExperience, testLogoPng, LONG_WORD, LONG_URL, CHAPTER_TITLES };
