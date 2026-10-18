/* eslint-disable */
// T3 (r57) — fixtures SINTÉTICOS de composición por necesidad y formatos S/M/L (+ formas de propuesta: 4×4 9+7,
// 4×5 9+11, 3×4 7+5, 32 h, 96 h). Cursos GENÉRICOS («Curso de ejemplo …»): ningún cliente, institución ni curso real.
// Todo determinista; sin red, sin IA, sin DB, USD 0. Lo usa check-composition-formats.js.
//
// Cada capítulo de contenido se define con una letra (su tipo de aprendizaje esperado):
//   P procedimental · R protocolo · K comunicación · D decisión/caso · N normativo/ético · C conceptual
// El título y el objetivo salen de un banco por tipo (el clasificador real los confirma en el check).
'use strict';

const crypto = require('crypto');
const path = require('path');

const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v), 'utf8').digest('hex');
const uuid = (prefix, n) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, '0')}`;

const TYPE_OF_LETTER = { P: 'procedimental', R: 'protocolo', K: 'comunicacion', D: 'decision_caso', N: 'normativo_etico', C: 'conceptual' };

/** Banco [título, objetivo] por tipo (objetivos en español neutro; temas de oficios genéricos). */
const BANK = {
  P: [
    ['Punto de equilibrio', 'Calcular el punto de equilibrio de un negocio'],
    ['Presupuesto mensual', 'Elaborar un presupuesto mensual en hoja de cálculo'],
    ['Red local', 'Configurar una red local paso a paso'],
    ['Asientos contables', 'Registrar los asientos contables del periodo'],
    ['Software de facturación', 'Instalar el software de facturación'],
    ['Tablas y gráficos', 'Insertar tablas y gráficos en un documento'],
    ['Soldadura por arco', 'Aplicar la técnica de soldadura por arco'],
    ['Informe técnico', 'Redactar un informe técnico con normas APA'],
  ],
  R: [
    ['Lavado de manos', 'Aplicar el protocolo de lavado de manos'],
    ['Plan de emergencia', 'Activar el plan de emergencia ante un incendio'],
    ['Primeros auxilios', 'Ejecutar los primeros auxilios ante una quemadura'],
    ['Bioseguridad', 'Seguir la lista de verificación de bioseguridad'],
    ['Evacuación', 'Realizar la evacuación del edificio según el procedimiento'],
  ],
  K: [
    ['Malas noticias', 'Comunicar malas noticias con empatía'],
    ['Acuerdos con proveedores', 'Negociar acuerdos con proveedores'],
    ['Entrevista de selección', 'Conducir una entrevista de selección'],
    ['Quejas y reclamos', 'Atender quejas y reclamos con escucha activa'],
    ['Primer contacto', 'Orientar al usuario en el primer contacto'],
  ],
  D: [
    ['Incidentes de seguridad', 'Decidir la mejor alternativa ante un incidente de seguridad'],
    ['Criterios de prioridad', 'Resolver casos de atención con criterios de prioridad'],
    ['Riesgos en obra', 'Priorizar riesgos en una situación de obra'],
    ['Alternativas de inversión', 'Evaluar alternativas de inversión en escenarios inciertos'],
    ['Fallas del motor', 'Diagnosticar fallas del motor a partir de los síntomas'],
  ],
  N: [
    ['Datos personales', 'Aplicar la ley de protección de datos personales'],
    ['Dilemas de la profesión', 'Analizar dilemas éticos de la profesión'],
    ['Reglamento interno', 'Cumplir el reglamento interno de trabajo'],
    ['Normativa ambiental', 'Interpretar la normativa ambiental vigente'],
    ['Derechos del trabajador', 'Reconocer los derechos y deberes del trabajador'],
    ['Consentimiento informado', 'Explicar el consentimiento informado y sus requisitos legales'],
  ],
  C: [
    ['Bases de la contabilidad', 'Explicar los conceptos básicos de la contabilidad'],
    ['Teoría del color', 'Comprender los principios de la teoría del color'],
    ['Materiales del taller', 'Identificar los tipos de materiales del taller'],
    ['Suelos agrícolas', 'Describir las características de los suelos agrícolas'],
    ['Sistemas de información', 'Diferenciar los elementos de un sistema de información'],
    ['Historia del diseño', 'Reconocer la evolución histórica del diseño gráfico'],
  ],
};
const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI'];

/**
 * Fixtures. `modules`: letras de los capítulos de CONTENIDO por módulo (la práctica la agrega el distribuidor con la
 * mezcla). `format`: S/M/L (la forma se elige con recommendShape y fija noContentAdditions). `practiceMix`: mezcla del
 * plan de aprendizaje. `expect`: lo que el check exige.
 */
const COURSES = [
  { id: 'S', format: 'S', targetHours: 21, modules: ['PCC', 'KCN', 'RCD'], practiceMix: null,
    expect: { modules: 3, content: 9, practice: 0 } },
  { id: 'M', format: 'M', targetHours: 42, modules: ['PCCD', 'RPCN', 'KDCP'], practiceMix: { format: 'M', practicePerModule: 1 },
    expect: { modules: 3, content: 12, practice: 3 } },
  { id: 'L', format: 'L', targetHours: 63, modules: ['PPCDR', 'RKCNP', 'DPPCK', 'RCPNP'], practiceMix: { format: 'L', practicePerModule: 1 },
    expect: { modules: 4, content: 20, practice: 4 } },
  { id: '4x4-9+7', targetHours: 64, modules: ['PRC', 'DK', 'PN', 'RC'], practiceMix: { modules: 4, chaptersPerModule: 4, practiceTotal: 7 },
    expect: { modules: 4, content: 9, practice: 7, practiceByModule: [1, 2, 2, 2] } },
  { id: '4x5-9+11', targetHours: 76, modules: ['PCD', 'RK', 'NP', 'DC'], practiceMix: { modules: 4, chaptersPerModule: 5, practiceTotal: 11 },
    expect: { modules: 4, content: 9, practice: 11, practiceByModule: [2, 3, 3, 3] } },
  { id: '3x4-7+5', targetHours: 40, modules: ['PCK', 'RD', 'NP'], practiceMix: { modules: 3, chaptersPerModule: 4, audiovisualTotal: 7 },
    expect: { modules: 3, content: 7, practice: 5, practiceByModule: [1, 2, 2] } },
  { id: '32h-3x3-5+4', targetHours: 32, modules: ['PC', 'KD', 'R'], practiceMix: { modules: 3, chaptersPerModule: 3, practiceTotal: 4 },
    expect: { modules: 3, content: 5, practice: 4, practiceByModule: [1, 1, 2] } },
  { id: '96h-4x6-10+14', targetHours: 96, modules: ['PRC', 'DKP', 'NC', 'RD'], practiceMix: { modules: 4, chaptersPerModule: 6, practiceTotal: 14 },
    expect: { modules: 4, content: 10, practice: 14, practiceByModule: [3, 3, 4, 4] } },
];

/**
 * Tres cursos de 40 h con la MISMA forma (4 × 4 de contenido, forma fijada) y necesidades distintas: 4, 12 y 15
 * capítulos que exigen video (procedimiento, protocolo o comunicación). Presupuesto de opcionales: floor(40 / 5) = 8.
 */
const VIDEO_40H = [
  { id: '40h-need4', targetHours: 40, modules: ['PCCN', 'PCNC', 'KCDN', 'RCDC'], expectVideos: 8 },
  { id: '40h-need12', targetHours: 40, modules: ['PRKC', 'PRKD', 'PRKN', 'PRKC'], expectVideos: 12 },
  { id: '40h-need15', targetHours: 40, modules: ['PRKP', 'RKPR', 'KPRK', 'PRKC'], expectVideos: 15 },
];

function structureOf(fx, n = 1) {
  const used = {};
  let ci = 0;
  const courseId = 9300 + n;
  return {
    course: { id: courseId, title: `Curso de ejemplo ${fx.id}`, finalExam: true, activityEngine: 'h5p', reviewCards: true },
    modules: fx.modules.map((letters, mi) => ({
      id: uuid('e', courseId * 10 + mi + 1),
      title: `Módulo ${mi + 1} del oficio`,
      objective: null,
      examEnabled: true,
      chapters: [...letters].map((L) => {
        ci++;
        const k = used[L] = (used[L] ?? -1) + 1;
        const [t, o] = BANK[L][k % BANK[L].length];
        const suffix = ROMAN[Math.floor(k / BANK[L].length)] || ` ${Math.floor(k / BANK[L].length) + 1}`;
        // Estructura «de siempre»: video y actividad encendidos en todos (el toggle por defecto del editor).
        return { id: uuid('f', courseId * 100 + ci), title: `${t}${suffix}`, objective: o, videoEnabled: true, activityEnabled: true, expectedType: TYPE_OF_LETTER[L] };
      }),
    })),
  };
}

/** Estructura sin la clave auxiliar `expectedType` (la que recibe el motor). */
function plainStructure(s) {
  return { course: { ...s.course }, modules: s.modules.map((m) => ({ ...m, chapters: m.chapters.map(({ expectedType, ...c }) => ({ ...c })) })) };
}

const LEARNER = { description: 'Personas adultas que se forman en un oficio técnico', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' };

function profileOf(fx, o = {}) {
  const composition = o.composition !== undefined ? o.composition : { videos: 'by_need', ...(fx.practiceMix ? { practiceMix: fx.practiceMix } : {}) };
  return {
    pedagogyProfileVersion: 1,
    primaryApproach: 'competencias',
    secondaryApproaches: [],
    learner: { ...LEARNER },
    learningOutcomes: { know: ['Los conceptos básicos del oficio'], do: ['Ejecutar los procedimientos del oficio'], competencies: ['Trabajar con seguridad y criterio'] },
    learningModes: ['practice'],
    experienceTypes: ['practice_experimentation'],
    assessmentMethods: ['practical_exercises'],
    principles: [],
    origin: 'manual',
    targetHours: fx.targetHours,
    ...(o.learningPlan === false ? {} : { learningPlan: { framework: 'teoria_demostracion_practica', ...(composition ? { composition } : {}) } }),
    ...(o.designPreferences ? { designPreferences: o.designPreferences } : {}),
  };
}

/** GIFT sintético con N preguntas (reparto 60/20/20 de examSlotSplit): salida simulada del generador de exámenes. */
function giftOf(prefix, split) {
  const out = [];
  for (let i = 0; i < split.multichoice; i++) out.push(`::${prefix}MC${i + 1}:: ¿Qué conducta corresponde en la situación ${i + 1} del oficio? {\n=Seguir el procedimiento acordado\n~Improvisar sin revisar\n~Omitir el registro\n}`);
  for (let i = 0; i < split.truefalse; i++) out.push(`::${prefix}VF${i + 1}:: Registrar cada paso facilita la trazabilidad (${i + 1}). {TRUE}`);
  for (let i = 0; i < split.match; i++) out.push(`::${prefix}REL${i + 1}:: Relaciona cada situación ${i + 1} con su respuesta. {\n=Riesgo detectado -> Detener y avisar\n=Duda técnica -> Consultar el manual\n=Tarea terminada -> Registrar el cierre\n}`);
  return out.join('\n\n');
}

function load(distRoot, rel) {
  return require(path.join(distRoot, rel));
}

module.exports = { COURSES, VIDEO_40H, BANK, TYPE_OF_LETTER, structureOf, plainStructure, profileOf, giftOf, sha, uuid, load };
