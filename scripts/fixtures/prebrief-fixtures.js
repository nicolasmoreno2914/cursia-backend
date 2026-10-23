'use strict';
/* eslint-disable */
// Prebrief pedagógico · fixtures SINTÉTICOS (datos ficticios; nunca documentos reales de terceros). Arman las entradas
// de buildPrebriefModel con la misma forma que devuelven CourseDesignService.recommend, «Lo que sabemos del curso» y el
// contexto académico. Uso: check-prebrief.js y la generación de PDFs de prueba.

const SRC = (quote, page) => [{ documentId: 'doc-1', section: null, page, line: 1, excerpt: quote }];

function chapters(n, start, opts) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = start + i;
    out.push({
      id: `ch-${k}`, proposed: false, kind: 'content', title: (opts.longTitles ? `Capítulo ${k}: análisis integral de procesos logísticos, inventarios y distribución en contextos regionales` : opts.titles && opts.titles[k - 1] ? opts.titles[k - 1] : `Capítulo ${k} de la operación logística`),
      videoEnabled: i < 2, activityEnabled: true, applicationMinutes: i === n - 1 ? 60 : null, hours: opts.hours || 3.5,
      outcomeIds: [`RA${((k - 1) % (opts.outcomes || 4)) + 1}`],
    });
  }
  return out;
}

const LOGISTICS_TITLES = [
  'Fundamentos de la cadena de suministro', 'Planeación de la demanda', 'Gestión de inventarios', 'Indicadores logísticos',
  'Almacenamiento y bodegaje', 'Transporte y distribución', 'Logística inversa', 'Compras y proveedores',
  'Operaciones esbeltas', 'Gestión de riesgos operativos', 'Tecnología en la operación', 'Proyecto integrador',
  'Costos logísticos', 'Servicio al cliente', 'Comercio exterior', 'Trazabilidad', 'Sostenibilidad', 'Planeación agregada', 'Mejora continua', 'Cierre',
];

/**
 * @param o.format 'S'|'M'|'L'|null · o.shape [capítulos por módulo] · o.doc4x5 requisito «4 × 5» (excepción si la forma no lo cumple)
 * o.reason motivo de la excepción · o.longName · o.longOutcomes · o.longTitles · o.practice capítulos de práctica por módulo
 */
function fixture(o = {}) {
  const shape = o.shape || [4, 4, 4];
  let k = 1;
  const modules = shape.map((n, mi) => {
    const chs = chapters(n, k, { titles: LOGISTICS_TITLES, longTitles: o.longTitles, hours: o.chapterHours });
    k += n;
    if (o.practice) chs.push({ id: `pr-${mi}`, proposed: false, kind: 'practice', title: `Práctica integradora del módulo ${mi + 1}`, videoEnabled: false, activityEnabled: true, applicationMinutes: 90, hours: 2, outcomeIds: ['RA1'] });
    return { id: `m-${mi + 1}`, title: ['Cadena de suministro', 'Operación del almacén', 'Distribución y mejora', 'Gestión estratégica', 'Integración', 'Cierre'][mi] || `Módulo ${mi + 1}`, examEnabled: true, chapters: chs };
  });
  const allCh = modules.flatMap((m) => m.chapters);
  const hours = Math.round(allCh.reduce((a, c) => a + c.hours, 0) * 10) / 10;
  const outcomesText = o.longOutcomes
    ? ['Analiza de manera integral la cadena de suministro de una organización de su región, identificando actores, flujos de información, materiales y recursos financieros, así como los principales riesgos operativos y las oportunidades de mejora que se derivan de ellos.', 'Planea la demanda con métodos cuantitativos.', 'Gestiona inventarios con indicadores.', 'Diseña una propuesta de mejora de la operación.']
    : ['Analiza la cadena de suministro de una organización.', 'Planea la demanda con métodos cuantitativos sencillos.', 'Gestiona inventarios y almacenes con indicadores.', 'Diseña una propuesta de mejora de la operación logística.'];
  const outcomes = outcomesText.map((t, i) => ({ id: `RA${i + 1}`, text: t, domain: 'do', origin: 'document' }));
  const reqItems = [];
  const reqChecks = [];
  const vchecks = [
    { id: 'hours', area: 'hours', severity: 'ok', title: 'Horas dentro de la meta' },
    { id: 'cost', area: 'cost', severity: 'ok', title: 'Costo estimado de generar ≈ USD 12,5 (entre 7,2 y 32)' },
  ];
  const sh = modules.map((m) => m.chapters.filter((c) => c.kind === 'content').length);
  if (o.doc4x5) {
    const r = { id: 'req-structure', key: 'structure|course', kind: 'structure', scope: { level: 'course' }, mode: 'exact', value: null, shape: [5, 5, 5, 5], obligation: 'required', applies: true, active: true, status: 'found', confidence: 'high', source: { documentId: 'doc-1', line: 12, page: 2, quote: 'El curso tendrá 4 módulos con 5 capítulos cada uno.' } };
    reqItems.push(r);
    // Como compareRequirements: la forma cuenta todos los capítulos; «practice» dice cuántos son de práctica (LOOP 9.1).
    const total = modules.map((m) => m.chapters.length);
    const met = total.length === 4 && total.every((n) => n === 5);
    reqChecks.push({ requirementId: r.id, status: met ? 'met' : 'unmet', actual: { shape: total, practice: modules.map((m) => m.chapters.length - m.chapters.filter((c) => c.kind === 'content').length) }, chosenBy: 'teacher', severity: met ? 'ok' : 'warning' });
    vchecks.push(met ? { id: 'requirement:req-structure', area: 'requirements', severity: 'ok', title: 'Requisito del documento: estructura 4 × 5 (20 capítulos)' }
      : { id: 'requirement:req-structure', area: 'requirements', severity: 'warning', title: 'Excepción al requisito del documento: estructura 4 × 5 (20 capítulos)', detail: 'Te estás apartando de un requisito del documento.' });
    const ev = { id: 'req-evals', key: 'evaluations|course|partial', kind: 'evaluations', scope: { level: 'course' }, mode: 'exact', value: shape.length, evaluationType: 'partial', obligation: 'required', applies: true, active: true, status: 'found', confidence: 'high', source: { documentId: 'doc-1', line: 20, page: 4, quote: `Se realizarán ${shape.length} evaluaciones parciales, una al cierre de cada módulo.` } };
    reqItems.push(ev);
    reqChecks.push({ requirementId: ev.id, status: 'met', actual: { value: shape.length }, chosenBy: 'cursia', severity: 'ok' });
    vchecks.push({ id: 'requirement:req-evals', area: 'requirements', severity: 'ok', title: `Requisito del documento: ${shape.length} evaluaciones parciales` });
    const vid = { id: 'req-videos', key: 'videos|chapter|each', kind: 'videos', scope: { level: 'chapter', each: true }, mode: 'min', value: 2, obligation: 'required', applies: true, active: true, status: 'found', confidence: 'high', source: { documentId: 'doc-1', line: 22, page: 4, quote: 'Cada capítulo incluirá al menos 2 videos.' } };
    reqItems.push(vid);
    reqChecks.push({ requirementId: vid.id, status: 'not_verifiable', actual: {}, chosenBy: 'cursia', severity: 'info', note: 'Cursia produce un video por capítulo.' });
    vchecks.push({ id: 'requirement:req-videos', area: 'requirements', severity: 'info', title: 'Requisito del documento por revisar: al menos 2 videos por capítulo' });
  }
  if (o.critical) vchecks.push({ id: 'outcome:RA4', area: 'outcomes', severity: 'critical', title: 'RA4 no tiene capítulos que lo desarrollen' });
  if (o.warning) vchecks.push({ id: 'practice', area: 'practice', severity: 'warning', title: 'El módulo 3 no tiene capítulo de práctica' });
  const card = {
    designVersion: 1,
    providersCalled: 0,
    profileChanged: !!o.profileChanged,
    approach: { id: 'competencias', label: 'Aprendizaje basado en competencias', source: o.approachSource || 'recommended', reasons: [] },
    suggestedApproach: 'competencias',
    hours: { target: o.targetHours !== undefined ? o.targetHours : 42, source: o.hoursSource || 'user' },
    verification: { verificationVersion: 1, checks: vchecks, counts: {}, blocking: vchecks.some((c) => c.severity === 'critical') },
    design: {
      status: 'within_tolerance', estimatedHours: o.estimatedHours || hours, baseHours: hours, applicable: o.applicable !== false, changes: o.pending ? [{ kind: 'add_practice' }] : [],
      counts: { modules: modules.length, chapters: allCh.length, evaluations: modules.length + 1 },
      modules,
    },
    manifestTotals: { videoCount: allCh.filter((c) => c.videoEnabled).length, presentationCount: allCh.filter((c) => c.kind === 'content').length, activityCount: allCh.length, applicationActivityCount: allCh.filter((c) => c.applicationMinutes).length, audiobookChapterCount: allCh.filter((c) => c.kind === 'content').length, audioWelcomeCount: 1 },
    blueprintSha256: 'b'.repeat(64),
    requirements: { items: reqItems, checks: reqChecks, alternatives: [], authority: { decisions: { audiovisual: null, applicationActivities: null } } },
  };
  const facts = {
    factsVersion: 1,
    title: { value: o.longName ? 'Gestión Logística y Operaciones para Organizaciones Productivas y de Servicios en Contextos Regionales de Latinoamérica' : 'Gestión Logística y Operaciones', source: 'user' },
    // Códigos reales del servicio de facts (LOOP 9: el modelo los convierte en rótulos para personas).
    educationLevel: { value: 'technical', source: o.doc4x5 ? 'document' : 'user' },
    priorKnowledge: { value: 'basic', source: 'inferred' },
    documentPrerequisites: o.doc4x5 ? ['Contabilidad básica', 'Manejo de hoja de cálculo'] : [],
    learnerDescription: { value: 'Técnicos y tecnólogos que trabajan o quieren trabajar en áreas de logística, bodegas y operaciones.', source: o.doc4x5 ? 'document' : 'user' },
    outcomes: { value: o.noOutcomes ? [] : outcomes, source: 'document' },
    competencies: { value: ['Gestiona procesos logísticos con criterios de eficiencia y servicio.'], source: 'document' },
    targetHours: { value: 42, source: 'user' },
    document: { present: !!o.doc4x5, proposed: false, contextVersion: o.doc4x5 ? 1 : null, names: o.doc4x5 ? ['Microcurriculo-logistica-demo.pdf'] : [] },
    sector: { value: 'Logística', source: 'user' },
    country: { value: 'Colombia', source: 'inferred' },
    institutionId: null,
    conflicts: [],
  };
  const academic = o.doc4x5 ? {
    academicContextVersion: 1,
    documents: [{ id: 'doc-1', name: 'Microcurriculo-logistica-demo.pdf', mediaType: 'application/pdf', sha256: 'd'.repeat(64), pages: 6, characters: 9000 }],
    identity: {
      subjectName: { status: 'found', value: 'Gestión Logística y Operaciones', sources: SRC('Asignatura: Gestión Logística y Operaciones', 1) },
      program: { status: 'found', value: 'Tecnología en Gestión Logística', sources: SRC('Programa: Tecnología en Gestión Logística', 1) },
      educationLevel: { status: 'found', value: { text: 'Tecnológico', level: 'technical' }, sources: [] },
      generalObjective: { status: 'found', value: o.templateObjective ? 'INSTRUCCIÓN: Tomar ejemplos del sector productivo de la región.' : 'Formar tecnólogos capaces de planear, ejecutar y mejorar operaciones logísticas con indicadores y criterios de servicio.', sources: SRC('Objetivo general: Formar tecnólogos capaces de planear…', 1) },
      description: { status: 'missing', value: null, sources: [] },
    },
    learner: { profile: { status: 'found', value: 'Técnicos y tecnólogos…', sources: [] }, priorKnowledge: { status: 'missing', value: null, sources: [] } },
    outcomes: outcomes.map((x, i) => ({ id: x.id, text: x.text, level: 'apply', domain: 'do', status: 'found', sources: SRC(x.text, 2 + (i % 2)) })),
    competencies: [{ id: 'CO1', text: 'Gestiona procesos logísticos con criterios de eficiencia y servicio.', status: 'found', sources: [] }],
    units: [],
    hours: { total: { status: 'found', value: 64, sources: [] }, weekly: { status: 'missing', value: null, sources: [] }, weeks: { status: 'missing', value: null, sources: [] }, credits: { status: 'found', value: 3, sources: [] }, components: [] },
    evaluation: [{ id: 'EV1', instrument: 'Estudio de caso de una bodega regional', weightPct: 30, outcomeIds: ['RA1', 'RA3'], status: 'found', sources: [] }, { id: 'EV2', instrument: 'Proyecto integrador de mejora', weightPct: 40, outcomeIds: ['RA4'], status: 'found', sources: [] }],
    bibliography: [],
    methodology: { status: 'found', value: 'Aprendizaje basado en problemas con casos del sector productivo regional.', sources: SRC('Metodología: aprendizaje basado en problemas…', 3) },
    constraints: { status: 'missing', value: null, sources: [] },
    additionalInfo: { status: 'missing', value: null, sources: [] },
    conflicts: [],
  } : null;
  const brief = {
    nombre: facts.title.value, obj: 'Formar personal capaz de gestionar la operación logística de una organización.', sector: 'Logística', pais: 'Colombia',
    contexto: o.level || 'Técnico', nivel: 'Básico', tono: 'Directo', comp: '', inferidos: 'sector,pais,tono',
  };
  const reasons = {};
  if (o.reason) reasons['structure|course'] = { reason: o.reason, requirementText: 'estructura 4 × 5 (20 capítulos)', by: 'docente@demo.test', at: '2026-10-08T12:00:00.000Z' };
  return {
    course: { id: 9001, title: facts.title.value, institutionName: 'Instituto de Formación Demo' },
    brief, facts, academic, card,
    format: o.format ? { code: o.format, catalogVersion: 1, at: '2026-10-08T11:00:00.000Z', by: 'docente@demo.test' } : null,
    structureSource: o.format ? 'teacher' : 'cursia',
    exceptionReasons: reasons,
    approachInfo: { summary: 'El curso se organiza alrededor de desempeños observables: qué debe saber hacer el participante, en qué situación y con qué criterio.', cycle: ['Cada módulo abre con el mapa de competencias: qué hará el participante y con qué criterio.', 'La práctica aplica el procedimiento en una situación real del puesto.', 'Se evalúa con evidencias de desempeño contra criterios explícitos.'] },
    alignContext: (c) => c,
    profiles: { assessment: { sha256: 'a'.repeat(64), data: { passingGrade: 70 } }, presentation: { sha256: 'p'.repeat(64), data: { themeFamily: 'aula-clara' } }, paletteId: null },
  };
}

module.exports = { fixture, LOGISTICS_TITLES };
