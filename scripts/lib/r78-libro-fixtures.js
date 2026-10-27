/* eslint-disable */
// r78 — «Libro Guía en el celular»: cursos SINTÉTICOS con un Libro Guía rico (todas las formas que el parser del Libro
// reconoce) para medir la lectura en línea (mod_book) contra el PDF. Sin IA, sin red, USD 0. Todo determinista.
//
//  - `libroCourseInput(dist, profile)`: el curso de r77 (7 estilos + marca propia; 2 módulos, 3 capítulos, práctica
//    guiada, audiolibro en línea r74) con el Markdown de cada capítulo cambiado por `richMd` (títulos ##/###/####,
//    párrafos con **negrita**, *cursiva*, `código` y enlaces, listas numeradas que empiezan en 3 y «sueltas», viñetas,
//    destacados con emoji, citas, tabla de 5 columnas, mapa conceptual con caracteres de cajas, griego, ≥ ≤ →, una palabra
//    y una dirección largas, normas citadas «Ley 1581 de 2012» / «ISO 9001:2015») y referencias del programa académico.
//  - `largeCourseInput(dist, profile)`: 3 módulos × 3 capítulos de ≈ 4 000 palabras cada uno (≈ 36 000 palabras, un PDF
//    de ≈ 150 páginas): el libro en línea tiene que quedar COMPLETO (nada se corta por tamaño).
'use strict';

const path = require('path');
const crypto = require('crypto');
const SF = require('./v21-shell-fixtures');
const V = require('./v21-packaging-fixtures');
const R77 = require('./r77-mobile-fixtures');
const MEDIA_BASE = 'https://api-staging.cursia.nomaddi.com';

const LONG_WORD = 'Interdepartamentalmente';
const LONG_URL = 'https://www.institucion-ejemplo.edu.co/recursos/atencion-al-cliente/protocolos/guia-de-escucha-activa-2026.pdf';

/** Párrafo determinista de ≈ `words` palabras (vocabulario del área, sin repetir frases idénticas). */
function prose(seed, words) {
  const V1 = ['El asesor', 'La persona usuaria', 'El equipo de servicio', 'La coordinación', 'Quien atiende', 'La organización'];
  const V2 = ['escucha con atención', 'confirma lo entendido', 'registra el caso', 'explica el siguiente paso', 'acuerda un plazo realista', 'revisa la información disponible'];
  const V3 = ['antes de responder', 'con palabras sencillas', 'sin prometer lo que no depende de su área', 'dentro del tiempo acordado', 'con un tono respetuoso', 'en el canal que el cliente eligió'];
  const out = [];
  let n = 0;
  let i = seed;
  while (n < words) {
    const s = `${V1[i % 6]} ${V2[(i * 7 + 3) % 6]} ${V3[(i * 5 + 1) % 6]}, y así la conversación avanza hacia una solución verificable número ${i % 97}.`;
    out.push(s);
    n += s.split(/\s+/).length;
    i += 1;
  }
  return out.join(' ');
}

/** Markdown rico de un capítulo (≈ 700 palabras; `large` → ≈ 4 000). */
function richMd(n, title, o = {}) {
  const reps = o.large ? 6 : 1;
  const parts = [`# Capítulo ${n}: ${title}`, ''];
  for (let r = 0; r < reps; r++) {
    const k = n * 10 + r;
    parts.push(
      `## Ideas centrales ${r ? `(parte ${r + 1})` : ''}`.trim(), '',
      `Este capítulo desarrolla **${title.toLowerCase()}** con ejemplos del servicio diario. Se aplica *escucha activa* y se registra cada caso con el código \`CASO-${k}\`. ${prose(k, o.large ? 260 : 60)}`, '',
      `La política de datos sigue la Ley 1581 de 2012 y el sistema de calidad la norma ISO 9001:2015; consulta el protocolo en ${LONG_URL} y la guía [de la institución](https://www.institucion-ejemplo.edu.co/guia). La coordinación ${LONG_WORD.toLowerCase()} evita respuestas contradictorias.`, '',
      '### Pasos del protocolo', '',
      '3. Saludar y presentarse con nombre.',
      '4. Escuchar sin interrumpir y tomar nota.',
      '',
      '5. Confirmar lo entendido con palabras propias.',
      `6. Acordar el siguiente paso y su plazo (≤ 48 horas si el caso es urgente).`, '',
      '- Escuchar antes de responder.',
      '- Confirmar lo entendido → evita reprocesos.',
      '- Cerrar con un próximo paso claro y **verificable**.', '',
      `💡 Un cliente que entiende el siguiente paso llama menos veces: la tasa de recontacto baja cuando Δt entre la respuesta y el cierre es corto (π ≈ 3,14 no tiene nada que ver aquí, pero los símbolos ≥ y ≤ sí).`, '',
      '> Una respuesta clara ahorra tres consultas posteriores.',
      '> Quien responde con calma, resuelve dos veces.', '',
      '| Situación | Canal | Respuesta recomendada | Tiempo máximo | Responsable |',
      '|---|---|---|---|---|',
      `| Cliente molesto | Teléfono | Reconocer la emoción y ofrecer una salida | 15 minutos | Asesor de primera línea |`,
      `| Consulta técnica | Correo electrónico | Explicar sin tecnicismos y adjuntar la guía | 24 horas | Soporte especializado |`,
      `| Reclamo formal | Presencial | Registrar, radicar y entregar el número de seguimiento | 5 días hábiles | Coordinación ${LONG_WORD.toLowerCase()} |`, '',
      '#### Mapa del proceso', '',
      '```',
      'Solicitud',
      '├── Registro ──> Clasificación',
      '│   ├── Urgente  ──> Respuesta en el día',
      '│   └── Normal   ──> Respuesta en 3 días',
      '└── Cierre ──> Encuesta de satisfacción ✅',
      '```', '',
      '---', '',
      `${prose(k + 50, o.large ? 260 : 50)}`, '',
    );
    if (o.large) {
      for (let j = 0; j < 3; j++) parts.push(`### Caso ${r + 1}.${j + 1}`, '', prose(k * 3 + j, 90), '');
    }
  }
  return parts.join('\n');
}

/** Referencias del programa académico (las publica el Libro tal cual). */
const PROGRAM_REFERENCES = [
  'Ministerio de Comercio, Industria y Turismo (2020). Guía de atención al ciudadano. Bogotá: MinCIT.',
  'Programa académico «Técnico en atención al cliente», documento institucional (2026).',
];

function richen(input, o = {}) {
  const titleOf = new Map();
  for (const m of input.plan ? input.plan.modules : []) for (const c of m.chapters) titleOf.set(c.chapterId, c.title);
  let n = 0;
  for (const id of [...input.contents.contentMd.keys()]) {
    n += 1;
    const old = input.contents.contentMd.get(id);
    const title = (/^#\s+Capítulo\s+\d+:\s+(.+)$/m.exec(old) || [])[1] || `Capítulo ${n}`;
    const num = Number((/^#\s+Capítulo\s+(\d+):/m.exec(old) || [])[1] || n);
    input.contents.contentMd.set(id, richMd(num, title, o));
  }
  input.libroReferences = [...PROGRAM_REFERENCES];
  return input;
}

/** Curso r77 (estilo dado) con el Libro rico. */
function libroCourseInput(dist, profile) {
  return richen(R77.mobileCourseInput(dist, profile));
}

const LARGE_TITLES = [
  'Fundamentos del servicio', 'Escucha y empatía', 'Comunicación clara',
  'Manejo de reclamos', 'Negociación de acuerdos', 'Seguimiento y fidelización',
  'Trabajo en equipo', 'Calidad del servicio', 'Mejora continua del servicio',
];

/** Curso grande: 3 módulos × 3 capítulos de ≈ 4 000 palabras (sin video ni actividades: lo que pesa es el Libro). */
function largeCourseInput(dist, profile) {
  const L = (r) => require(path.join(dist, r));
  const P = L('modules/course-profiles/course-profiles.js');
  const PK = L('modules/dynamic-packaging/packaging-v3.js');
  const SD = L('modules/dynamic-packaging/split-delivery-v3.js');
  const DP = L('package/v3/delivery-plan.js');
  const { snapshot, manifest } = SF.buildCourse(dist, {
    courseId: 7801,
    title: 'Servicio al cliente: curso completo de nueve capítulos',
    finalExam: true,
    engine: 'h5p',
    chapterTitles: LARGE_TITLES,
    modules: [
      { examEnabled: true, chapters: [{}, {}, {}] },
      { examEnabled: true, chapters: [{}, {}, {}] },
      { examEnabled: false, chapters: [{}, {}, {}] },
    ],
  });
  const assessment = P.defaultAssessmentProfile({ finalExam: true });
  const norm = P.normalizePresentationProfile(profile);
  const input = V.packagingInput(dist, { snapshot, manifest, engine: 'h5p', profile: assessment });
  input.presentation = PK.resolvePackagingTheme({ presentationProfile: norm }).input;
  const brand = PK.applyPresentationIdentity({ logo: null, candidates: [], name: null, warnings: [] }, P.presentationIdentityOf(norm));
  input.libroBrand = { logo: brand.candidates, name: brand.name, ...(brand.watermark === false ? { watermark: false } : {}), ...(brand.showInCourse ? { showInCourse: true } : {}) };
  const plan = DP.planAudioParts(SD.audioChapterSizes(input), { partMaxBytes: 200 * 1024 * 1024, maxParts: 20 });
  if (!plan.ok) throw new Error(`plan de audio: ${plan.reason}`);
  const links = {};
  let k = 0;
  for (const sg of SD.audiobookSegmentsOf(input, plan.parts)) {
    k += 1;
    const id = `00000000-0000-4000-8000-${String(780000000000 + k)}`;
    links[sg.key] = `${MEDIA_BASE}/api/v1/media/${id}/${crypto.createHash('sha256').update(`r78-${sg.key}`).digest('hex')}/${sg.file}`;
  }
  input.audiobookDelivery = { mode: 'linked', parts: plan.parts, links };
  return richen(input, { large: true });
}

module.exports = { libroCourseInput, largeCourseInput, richMd, prose, PROGRAM_REFERENCES, LONG_WORD, LONG_URL, STYLES: R77.STYLES, customStyle: R77.customStyle };
