#!/usr/bin/env node
/* eslint-disable */
// T2 (r57) — Plan de aprendizaje: tipo de aprendizaje por capítulo, actividad derivada y marco instruccional
// (metodología) como datos. Check puro contra el código COMPILADO (dist/; correr "npm run build" antes).
// Sin red, sin IA, sin DB, USD 0.
//
//   L1  tabla de clasificación (≥ 30 objetivos en español) + justificación (regla + evidencia)
//   L2  determinismo (clasificador, lock, Manifest, briefs, dry-run)
//   L3  precedencia del override (capítulo > reglas; marco: capítulo > módulo > curso)
//   L4  actividad por tipo de aprendizaje (reglas H5P v2 y v1), balance dentro de los candidatos
//   L5  registro de marcos: los incluidos validan; definiciones rotas se rechazan; uno nuevo se agrega por datos
//   L6  briefs de Gagné y TDP con las indicaciones de cada fase (y bajo el tope del ejecutor)
//   L7  validatePedagogy por marco + gate por versión del prompt (v21-exp-7)
//   L8  compatibilidad: sin plan, perfil/lock/Manifest/briefs/huellas/dry-run/facts/shell byte a byte como antes
//   L9  proyección del diseño (dry-run) con tipo, justificación y decisión de la actividad; catálogo
//   L10 rótulos de fase en el shell (solo con phaseLabels) y huellas: phaseLabels no regenera, el override sí
//
// Usage: node scripts/check-learning-plan.js [path/to/dist]

const path = require('path');

const distArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿corriste "npm run build"?): ${err.message}`);
    process.exit(1);
  }
}

const P = loadDist('modules/pedagogy/index.js');
const B = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const FP = loadDist('modules/invalidation/fingerprints.js');
const S = loadDist('modules/course-shell/index.js');
const V3 = loadDist('modules/course-shell/v3-validation.js');
const vc = loadDist('modules/visual-components/index.js');
const te = loadDist('modules/theme-engine/index.js');
const cp = loadDist('modules/course-profiles/course-profiles.js');
const L = require('./lib/learning-plan-fixtures');
const SF = require('./lib/v21-shell-fixtures');
const VCF = require('./lib/v21-vc-fixtures');
const GOLDEN = require('./fixtures/learning-plan/golden-off.json');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}\n   ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 4).join('\n   ')}`);
  }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
function eq(a, b, msg) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${msg}: ${x} !== ${y}`); }
function throwsRe(fn, re, msg) {
  try { fn(); } catch (e) { if (re.test(String(e.message))) return; throw new Error(`${msg}: error inesperado ${e.message}`); }
  throw new Error(`${msg}: no lanzó`);
}

const withPlan = (lp) => L.baseProfile({ learningPlan: lp });
const chaptersOf = (s) => [...s.modules].sort((a, b) => a.position - b.position).flatMap((m) => [...m.chapters].sort((a, b) => a.position - b.position));

// ── L1 ──────────────────────────────────────────────────────────────────────
const TABLE = [
  // conceptual
  ['Explicar los conceptos básicos de la contabilidad', 'conceptual'],
  ['Comprender los principios de la teoría del color', 'conceptual'],
  ['Identificar los tipos de materiales del taller', 'conceptual'],
  ['Describir las características de los suelos agrícolas', 'conceptual'],
  ['Diferenciar los elementos de un sistema de información', 'conceptual'],
  ['Reconocer la evolución histórica del diseño gráfico', 'conceptual'],
  ['Conocer el oficio', 'conceptual'],
  // procedimental
  ['Calcular el punto de equilibrio de un negocio', 'procedimental'],
  ['Elaborar un presupuesto mensual en hoja de cálculo', 'procedimental'],
  ['Configurar una red local paso a paso', 'procedimental'],
  ['Redactar un informe técnico con normas APA', 'procedimental'],
  ['Insertar tablas y gráficos en un documento', 'procedimental'],
  ['Registrar los asientos contables del periodo', 'procedimental'],
  ['Instalar el software de facturación', 'procedimental'],
  ['Aplicar la técnica de soldadura por arco', 'procedimental'],
  // protocolo
  ['Aplicar el protocolo de lavado de manos', 'protocolo'],
  ['Activar el plan de emergencia ante un incendio', 'protocolo'],
  ['Ejecutar los primeros auxilios ante una quemadura', 'protocolo'],
  ['Seguir la lista de verificación de bioseguridad', 'protocolo'],
  ['Realizar la evacuación del edificio según el procedimiento', 'protocolo'],
  // decisión / caso
  ['Decidir la mejor alternativa ante un incidente de seguridad', 'decision_caso'],
  ['Resolver casos de atención con criterios de prioridad', 'decision_caso'],
  ['Priorizar riesgos en una situación de obra', 'decision_caso'],
  ['Evaluar alternativas de inversión en escenarios inciertos', 'decision_caso'],
  ['Diagnosticar fallas del motor a partir de los síntomas', 'decision_caso'],
  // comunicación
  ['Comunicar malas noticias con empatía', 'comunicacion'],
  ['Negociar acuerdos con proveedores', 'comunicacion'],
  ['Conducir una entrevista de selección', 'comunicacion'],
  ['Atender quejas y reclamos con escucha activa', 'comunicacion'],
  ['Orientar al usuario en el primer contacto', 'comunicacion'],
  // normativo / ético
  ['Aplicar la ley de protección de datos personales', 'normativo_etico'],
  ['Analizar dilemas éticos de la profesión', 'normativo_etico'],
  ['Cumplir el reglamento interno de trabajo', 'normativo_etico'],
  ['Explicar el consentimiento informado y sus requisitos legales', 'normativo_etico'],
  ['Reconocer los derechos y deberes del trabajador', 'normativo_etico'],
  ['Interpretar la normativa ambiental vigente', 'normativo_etico'],
];

check('L1 clasificación: tabla de 36 objetivos (los 6 tipos, verbos en español) da el tipo esperado', () => {
  assert(TABLE.length >= 30, 'al menos 30 ejemplos');
  const bad = TABLE.filter(([o, want]) => P.classifyLearningType({ objective: o }).type !== want).map(([o, want]) => `${o} → ${P.classifyLearningType({ objective: o }).type} (esperado ${want})`);
  eq(bad, [], 'clasificaciones erradas');
  for (const t of P.LEARNING_TYPES) assert(TABLE.some(([, w]) => w === t), `falta un ejemplo de ${t}`);
});

check('L1 justificación: regla ganadora + evidencia (campo y pista) + nivel Bloom; sin pistas → lt.default', () => {
  const r = P.classifyLearningType({ objective: 'Aplicar el protocolo de lavado de manos', title: 'Higiene', description: null });
  eq([r.type, r.ruleId, r.level], ['protocolo', 'lt.protocolo.term', 'apply'], 'regla y nivel');
  eq(r.evidence[0], { field: 'objective', cue: 'protocol*', kind: 'term' }, 'evidencia');
  const d = P.classifyLearningType({ objective: null, title: 'Unidad uno', description: '' });
  eq([d.type, d.ruleId, d.evidence.length], ['conceptual', 'lt.default', 0], 'sin pistas');
  assert(/por defecto/.test(P.learningTypeJustification({ ...P.resolveChapterLearningType({ title: 'Unidad uno' }) })), 'texto de justificación por defecto');
  // El campo pesa: el objetivo (3) gana a la descripción (1); «en caso de» no es un caso.
  eq(P.classifyLearningType({ objective: 'Explicar los conceptos de higiene', description: 'Se analizan casos y decisiones' }).type, 'conceptual', 'objetivo > descripción');
  eq(P.classifyLearningType({ objective: 'Aplicar el protocolo en caso de derrame' }).scores.decision_caso, undefined, '«en caso de» no suma decisión');
  // Empate → el más específico (prioridad fija).
  eq(P.classifyLearningType({ title: 'Ley y conceptos' }).type, 'normativo_etico', 'empate → prioridad');
});

// ── L2 ──────────────────────────────────────────────────────────────────────
check('L2 determinismo: misma entrada → mismo tipo, mismo lock, mismo Manifest, mismos briefs y mismo dry-run', () => {
  for (const [o] of TABLE) eq(P.classifyLearningType({ objective: o }), P.classifyLearningType({ objective: o }), `clasificador ${o}`);
  const prof = withPlan({ framework: 'gagne_9_eventos' });
  const a = L.lockAndManifest(distRoot, L.STRUCTURE, prof, 2);
  const b = L.lockAndManifest(distRoot, JSON.parse(JSON.stringify(L.STRUCTURE)), JSON.parse(JSON.stringify(prof)), 2);
  eq(a.errors, [], 'Manifest válido');
  eq(snap.snapshotSha256V2(a.snapshot), snap.snapshotSha256V2(b.snapshot), 'lock');
  eq(B.manifestSha256(a.manifest), B.manifestSha256(b.manifest), 'Manifest');
  const briefs = (x) => x.manifest.items.map((it) => P.buildItemPedagogyBrief({ item: it, snapshot: x.snapshot, activityTypeRules: 2 }));
  eq(L.sha(briefs(a)), L.sha(briefs(b)), 'briefs');
  eq(L.sha(P.runPedagogyDryRun({ structure: L.STRUCTURE, profile: prof })), L.sha(P.runPedagogyDryRun({ structure: L.STRUCTURE, profile: prof })), 'dry-run');
  // Reordenar las claves del perfil no cambia nada (perfil normalizado).
  const shuffled = { learningPlan: { chapterOverrides: {}, framework: 'gagne_9_eventos' }, ...L.baseProfile() };
  eq(P.pedagogicalProfileSha256(P.normalizePedagogicalProfile(shuffled)), P.pedagogicalProfileSha256(P.normalizePedagogicalProfile(prof)), 'perfil normalizado');
});

// ── L3 ──────────────────────────────────────────────────────────────────────
const C = (n) => L.uuid('c', n);
const M = (n) => L.uuid('a', n);
check('L3 override del docente: manda sobre las reglas y deja la sugerencia a la vista', () => {
  const prof = withPlan({ framework: 'default', chapterOverrides: { [C(1)]: { learningType: 'decision_caso' }, [C(3)]: { learningType: 'procedimental' } } });
  const s = L.lockAndManifest(distRoot, L.STRUCTURE, prof, 2).snapshot;
  const byId = new Map(chaptersOf(s).map((c) => [c.id, c.design.learningType]));
  eq([byId.get(C(1)).type, byId.get(C(1)).source, byId.get(C(1)).ruleId, byId.get(C(1)).suggested], ['decision_caso', 'override', 'lt.override', 'conceptual'], 'override distinto de la regla');
  eq([byId.get(C(3)).type, byId.get(C(3)).source, byId.get(C(3)).suggested], ['procedimental', 'override', undefined], 'override igual a la regla: sin «suggested»');
  eq(byId.get(C(2)).source, 'rules', 'los demás siguen las reglas');
  assert(/Fijado por el docente/.test(P.learningTypeJustification(byId.get(C(1)))), 'justificación del override');
});

check('L3 marco: capítulo > módulo > curso; un módulo con marco propio lo lleva en su diseño y en su examen', () => {
  const prof = withPlan({ framework: 'teoria_demostracion_practica', moduleFrameworks: { [M(2)]: 'gagne_9_eventos' }, chapterOverrides: { [C(7)]: { framework: 'default' } } });
  const lm = L.lockAndManifest(distRoot, L.STRUCTURE, prof, 2);
  eq(lm.errors, [], 'Manifest válido');
  const fw = new Map(chaptersOf(lm.snapshot).map((c) => [c.id, c.design.framework]));
  eq([fw.get(C(1)), fw.get(C(4)), fw.get(C(6)), fw.get(C(7)), fw.get(C(8))], ['teoria_demostracion_practica', 'gagne_9_eventos', 'gagne_9_eventos', 'default', 'teoria_demostracion_practica'], 'marcos resueltos');
  eq(lm.snapshot.modules.map((m) => m.design.framework), ['teoria_demostracion_practica', 'gagne_9_eventos', 'teoria_demostracion_practica'], 'marco del módulo');
  eq(lm.manifest.items.find((i) => i.key === `exam:${M(2)}`).design.framework, 'gagne_9_eventos', 'examen del módulo');
  eq(lm.manifest.items.find((i) => i.type === 'final_exam').design.framework, 'teoria_demostracion_practica', 'examen final = marco del curso');
});

check('L3 perfil: metodología o tipo desconocidos, sin enfoque o con campos extra → PROFILE_INVALID (nunca se ignora)', () => {
  const codes = (p) => P.validatePedagogicalProfile(p).map((e) => e.code);
  assert(codes(withPlan({ framework: 'inventado' })).includes('UNKNOWN_FRAMEWORK'), 'marco desconocido');
  assert(codes(withPlan({ framework: 'default', chapterOverrides: { x1: { learningType: 'otro' } } })).includes('INVALID_OPTION'), 'tipo desconocido');
  assert(codes(withPlan({ framework: 'default', extra: 1 })).includes('UNKNOWN_FIELD'), 'campo extra');
  assert(codes({ ...withPlan({ framework: 'default' }), primaryApproach: null }).includes('LEARNING_PLAN_WITHOUT_APPROACH'), 'sin enfoque');
  throwsRe(() => P.normalizePedagogicalProfile(withPlan({ framework: 'inventado' })), /PROFILE_INVALID/, 'normalize');
  eq(P.normalizePedagogicalProfile(withPlan({ framework: 'default', chapterOverrides: { z: {}, a: { learningType: 'conceptual' } } })).learningPlan, { framework: 'default', chapterOverrides: { a: { learningType: 'conceptual' } } }, 'normalizado: vacíos fuera, ordenado');
});

// ── L4 ──────────────────────────────────────────────────────────────────────
function activityStructure(objectives) {
  return {
    course: { id: 9201, title: 'Curso procedimental de ejemplo', finalExam: false, activityEngine: 'h5p' },
    modules: [{ id: L.uuid('e', 1), title: 'Módulo único', examEnabled: false, chapters: objectives.map((o, i) => ({ id: L.uuid('f', i + 1), title: `Capítulo ${i + 1}`, objective: o, videoEnabled: false, activityEnabled: true })) }],
  };
}
const OBJ = {
  conceptual_remember: 'Identificar los términos del oficio',
  conceptual_understand: 'Explicar los conceptos del oficio',
  procedimental_low: 'Seguir paso a paso la técnica de corte',
  procedimental_apply: 'Calcular el costo de producción',
  protocolo: 'Aplicar el protocolo de bioseguridad',
  decision: 'Decidir la mejor alternativa ante un incidente',
  comunicacion: 'Negociar acuerdos con proveedores',
  normativo: 'Aplicar la normativa de protección de datos',
};
check('L4 actividad por tipo de aprendizaje (H5P v2): tabla de datos, no rotación por hash', () => {
  const keys = Object.keys(OBJ);
  // 8 actividades: tope de escenarios ramificados = max(1, floor(8/4)) = 2 → decisión y comunicación lo usan.
  const lm = L.lockAndManifest(distRoot, activityStructure(keys.map((k) => OBJ[k])), withPlan({ framework: 'default' }), 2);
  eq(lm.errors, [], 'Manifest válido');
  const dec = P.choosePedagogicalActivityTypes(lm.snapshot, 2);
  const got = Object.fromEntries(keys.map((k, i) => [k, [dec.get(L.uuid('f', i + 1)).type, dec.get(L.uuid('f', i + 1)).reason, dec.get(L.uuid('f', i + 1)).learningType.ruleId]]));
  eq(got, {
    conceptual_remember: ['blanks', 'learning_type', 'la.conceptual.remember'],
    conceptual_understand: ['dragtext', 'learning_type', 'la.conceptual.understand'],
    procedimental_low: ['dragtext', 'learning_type', 'la.procedimental'],
    procedimental_apply: ['questionset', 'learning_type', 'la.procedimental.apply'],
    protocolo: ['dragtext', 'learning_type', 'la.protocolo'],
    decision: ['branchingscenario', 'learning_type', 'la.decision_caso'],
    comunicacion: ['branchingscenario', 'learning_type', 'la.comunicacion'],
    normativo: ['questionset', 'learning_type', 'la.normativo_etico'],
  }, 'tipo por capítulo');
  // El Manifest congela exactamente esas decisiones (y el validador las recalcula: errors = []).
  for (const [i] of keys.entries()) eq(lm.manifest.items.find((x) => x.key === `activity:${L.uuid('f', i + 1)}`).h5pType, dec.get(L.uuid('f', i + 1)).type, `h5pType ${i + 1}`);
  // Sin plan (mismo curso): el tipo sale de la intención del enfoque (otra decisión).
  const off = L.lockAndManifest(distRoot, activityStructure(keys.map((k) => OBJ[k])), L.baseProfile(), 2);
  assert(off.manifest.items.filter((x) => x.type === 'activity').some((x, i) => x.h5pType !== lm.manifest.items.filter((y) => y.type === 'activity')[i].h5pType), 'con plan cambia la elección');
  assert([...P.choosePedagogicalActivityTypes(off.snapshot, 2).values()].every((d) => d.reason !== 'learning_type' && !d.learningType), 'sin plan no hay razón learning_type');
});

check('L4 H5P v1 (sin escenarios ramificados): decisión y comunicación caen en preguntas de caso; balance dentro de los candidatos', () => {
  const lm = L.lockAndManifest(distRoot, activityStructure([OBJ.decision, OBJ.comunicacion, OBJ.decision, OBJ.decision, OBJ.decision]), withPlan({ framework: 'default' }), 1);
  eq(lm.errors, [], 'Manifest válido');
  const dec = [...P.choosePedagogicalActivityTypes(lm.snapshot, 1).values()];
  assert(dec.every((d) => d.type === 'questionset'), 'todos questionset: ' + JSON.stringify(dec.map((d) => d.type)));
  // La variedad nunca saca un capítulo de su lista (decisión no tiene otro candidato disponible en v1).
  assert(dec.every((d) => d.learningType.candidates.includes(d.type)), 'siempre dentro de los candidatos');
  // Con v2 y muchas decisiones: el tope de ramificados deja el resto en questionset (dentro de la lista), con la razón visible.
  const v2 = [...P.choosePedagogicalActivityTypes(L.lockAndManifest(distRoot, activityStructure(Array(8).fill(OBJ.decision)), withPlan({ framework: 'default' }), 2).snapshot, 2).values()];
  eq(v2.filter((d) => d.type === 'branchingscenario').length, 2, 'tope de ramificados = 2 de 8');
  eq(v2.filter((d) => d.reason === 'branching_cap').length, 6, 'el resto con razón branching_cap');
  assert(v2.every((d) => ['branchingscenario', 'questionset'].includes(d.type)), 'nunca un tipo ajeno al tipo de aprendizaje');
  // Determinismo de la tabla.
  eq(P.learningTypeActivityRule('procedimental', 'apply', ['questionset', 'dragtext', 'blanks']), P.learningTypeActivityRule('procedimental', 'apply', ['questionset', 'dragtext', 'blanks']), 'tabla');
});

// ── L5 ──────────────────────────────────────────────────────────────────────
check('L5 registro de marcos: default, TDP y Gagné validan; fases y bloques del vocabulario cerrado', () => {
  const reg = P.defaultFrameworkRegistry();
  eq(reg.ids(), ['default', 'teoria_demostracion_practica', 'gagne_9_eventos'], 'ids');
  for (const f of reg.list()) eq(P.validateFrameworkDefinition(f), [], `válido ${f.id}`);
  eq(reg.get('gagne_9_eventos').phases.length, 9, 'Gagné tiene 9 eventos');
  eq(reg.get('teoria_demostracion_practica').phases.map((p) => p.id), ['teoria', 'demostracion', 'practica'], 'TDP');
  assert(Object.isFrozen(reg.get('gagne_9_eventos').phases[0]), 'definiciones congeladas');
});

check('L5 definiciones rotas se rechazan con un motivo; un marco nuevo se agrega SOLO con datos', () => {
  const base = JSON.parse(JSON.stringify(P.defaultFrameworkRegistry().get('teoria_demostracion_practica')));
  const bad = (mut, re) => { const d = JSON.parse(JSON.stringify(base)); mut(d); const errs = P.validateFrameworkDefinition(d); assert(errs.some((e) => re.test(`${e.path} ${e.message}`)), `${re}: ${JSON.stringify(errs)}`); };
  bad((d) => { d.phases[0].slots = ['inventado']; }, /bloque desconocido/);
  bad((d) => { d.phases[1].id = d.phases[0].id; }, /fase repetida/);
  bad((d) => { d.phases[0].order = 3; }, /orden 1..n/);
  bad((d) => { d.phases[2].slots = ['activity']; }, /obligatoria/);
  bad((d) => { d.phases[0].directives.libro = 'x'; }, /generador desconocido/);
  bad((d) => { d.experienceRequirements[0].anyOf = ['no_existe']; }, /catálogo visual/);
  bad((d) => { d.experienceRequirements[0].phase = 'nada'; }, /fase inexistente/);
  bad((d) => { d.id = 'Mal Id'; }, /id inválido/);
  const reg = new P.InstructionalFrameworkRegistry();
  reg.register({
    id: 'ciclo_de_ejemplo', version: 1, label: 'Ciclo de ejemplo', shortLabel: 'Ciclo', summary: 'Explorar, practicar y transferir.', phaseLabelsDefault: false,
    phases: [
      { id: 'explorar', order: 1, label: 'Explorar', studentLabel: 'Explora', slots: ['opening', 'deepening'], required: true, elements: ['Apertura'], directives: { content: 'Fase Explorar: parte de una pregunta abierta.' } },
      { id: 'practicar', order: 2, label: 'Practicar', studentLabel: 'Practica', slots: ['activity'], required: false, elements: ['Actividad'], directives: { activity: 'Fase Practicar: ejecuta lo explorado.' } },
    ],
    experienceRequirements: [],
  });
  eq(P.frameworkDirectivesFor(reg.get('ciclo_de_ejemplo'), 'content').map((x) => x.text), ['Fase Explorar: parte de una pregunta abierta.'], 'indicaciones del marco nuevo');
  eq(P.learningPlanDirectives('content', { framework: 'ciclo_de_ejemplo' }, undefined, reg).map((x) => x.target), ['framework.explorar', 'framework'], 'el brief usa el marco nuevo sin tocar el motor');
  throwsRe(() => reg.register(reg.get('ciclo_de_ejemplo')), /FRAMEWORK_DUPLICATE/, 'duplicado');
  eq(P.missingLearningPlanTexts(), [], 'textos completos por tipo × generador');
  eq(P.missingGeneratorTexts(), [], 'missingGeneratorTexts sin faltantes');
});

// ── L6 ──────────────────────────────────────────────────────────────────────
function briefsFor(framework) {
  const lm = L.lockAndManifest(distRoot, L.STRUCTURE, withPlan({ framework }), 2);
  const get = (type, ch) => {
    const it = lm.manifest.items.find((i) => i.type === type && (ch === undefined || i.chapterId === ch));
    return P.buildItemPedagogyBrief({ item: it, snapshot: lm.snapshot, activityTypeRules: 2 });
  };
  return { lm, get };
}
check('L6 Gagné: los briefs llevan las indicaciones de cada evento a su generador; requisitos solo en capítulos de contenido', () => {
  const { lm, get } = briefsFor('gagne_9_eventos');
  const exp = get('experience', C(1));
  for (const n of [1, 2, 3, 4, 5, 9]) assert(exp.text.includes(`Evento ${n}`), `experiencia: evento ${n}`);
  eq(exp.experienceRequirements.map((r) => r.id), ['gagne.objective', 'gagne.activation', 'gagne.guidance'], 'requisitos del marco');
  assert(get('content', C(1)).text.includes('Evento 2 (informar el objetivo)'), 'contenido: evento 2');
  assert(get('activity', C(1)).text.includes('Evento 6') && get('activity', C(1)).text.includes('Evento 7'), 'actividad: eventos 6 y 7');
  assert(get('exam').text.includes('Evento 8'), 'examen: evento 8');
  assert(get('video', C(1)).text.includes('Evento 5'), 'video: evento 5');
  assert(get('module_intro').text.includes('Evento 1'), 'presentación del módulo: evento 1');
  assert(exp.text.includes('sin nombrarlas en el texto'), 'el texto generado no nombra las fases (vocabulario interno)');
  assert(get('experience', C(6)).experienceRequirements === undefined, 'capítulo de práctica sin requisitos del marco');
  // Tipo de aprendizaje en el brief de cada generador del capítulo + traza de la actividad.
  assert(get('content', C(4)).text.includes('Capítulo de protocolo'), 'contenido: tipo de aprendizaje');
  assert(/Arrastrar y ordenar: el texto recorre la secuencia del protocolo/.test(get('activity', C(4)).text), 'actividad: qué hace el dragtext de un protocolo');
  for (const it of lm.manifest.items) {
    const b = P.buildItemPedagogyBrief({ item: it, snapshot: lm.snapshot, activityTypeRules: 2 });
    if (b) assert(b.text.length <= P.PEDAGOGY_BRIEF_TEXT_MAX, `${it.key}: brief de ${b.text.length} > ${P.PEDAGOGY_BRIEF_TEXT_MAX}`);
    if (b && it.type === 'presentation') assert(b.text.length <= 1200, `${it.key}: el brief de Gamma debe caber holgado (${b.text.length})`);
  }
});

check('L6 TDP: Teoría, Demostración y Práctica llegan al contenido, la experiencia, el video y las actividades', () => {
  const { get } = briefsFor('teoria_demostracion_practica');
  const content = get('content', C(3)).text;
  assert(content.includes('Fase Teoría') && content.includes('Fase Demostración'), 'contenido');
  assert(get('video', C(3)).text.includes('Fase Demostración'), 'video de demostración');
  assert(get('activity', C(3)).text.includes('Fase Práctica'), 'actividad');
  assert(get('application_activity', C(3)).text.includes('Fase Práctica'), 'Actividad de Aplicación');
  assert(get('guided_practice', C(5)).text.includes('Fase Práctica'), 'práctica guiada');
  eq(get('experience', C(3)).experienceRequirements.map((r) => r.id), ['tdp.demonstration'], 'requisito de demostración');
  const d = get('experience', C(3)).directives.map((x) => x.target);
  assert(d.includes('learningType') && d.includes('framework.teoria') && d.includes('framework.demostracion'), 'directivas con traza por fase');
  // El marco estándar no agrega indicaciones de fase (solo el tipo de aprendizaje).
  const std = briefsFor('default').get('content', C(3));
  assert(!std.directives.some((x) => x.target.startsWith('framework.')) && std.directives.some((x) => x.target === 'learningType'), 'default: sin fases, con tipo');
});

// ── L7 ──────────────────────────────────────────────────────────────────────
function experienceDoc() {
  const doc = JSON.parse(JSON.stringify(VCF.chapterExperienceFixture ? VCF.chapterExperienceFixture('ch-x') : SF.experienceFor('ch-x')));
  return doc;
}
check('L7 validatePedagogy por marco: Gagné exige objetivo, activación y ejemplo resuelto; sin marco, lo de siempre', () => {
  const doc = experienceDoc();
  const reqG = P.defaultFrameworkRegistry().get('gagne_9_eventos').experienceRequirements;
  const base = vc.validatePedagogy(doc).map((e) => e.code);
  eq(vc.validatePedagogy(doc, undefined).map((e) => e.code), base, 'sin opciones = idéntico');
  // Quitar learning_objectives y reflection de la apertura → los dos requisitos de Gagné fallan.
  doc.movements.opening = doc.movements.opening.filter((c) => c.type !== 'learning_objectives' && c.type !== 'reflection');
  const errs = vc.validatePedagogy(doc, { requirements: reqG }).filter((e) => e.code === 'FRAMEWORK_ELEMENT_MISSING');
  assert(errs.some((e) => /gagne\.objective/.test(e.message)) && errs.some((e) => /gagne\.activation/.test(e.message)), JSON.stringify(errs));
  // Agregarlos los cumple.
  doc.movements.opening = [doc.movements.opening[0], { type: 'learning_objectives', title: 'Lo que vas a lograr', items: ['Ejecutar el paso uno con criterio', 'Verificar el resultado'] }, { type: 'reflection', prompt: '¿Qué sabes ya de esta tarea?' }];
  const hasWE = ['deepening'].some((m) => doc.movements[m].some((c) => c.type === 'worked_example'));
  const left = vc.validatePedagogy(doc, { requirements: reqG }).filter((e) => e.code === 'FRAMEWORK_ELEMENT_MISSING').map((e) => e.message);
  eq(left.filter((m) => /gagne\.(objective|activation)/.test(m)), [], 'objetivo y activación cumplidos');
  eq(left.some((m) => /gagne\.guidance/.test(m)), !hasWE, 'ejemplo resuelto según el documento');
});

check('L7 gate por versión del prompt: los requisitos del marco se exigen solo desde v21-exp-7', () => {
  assert(!V3.frameworkRequirementsApply('v21-exp-6') && V3.frameworkRequirementsApply('v21-exp-7') && !V3.frameworkRequirementsApply(null), 'gate');
  const doc = experienceDoc();
  doc.movements.opening = doc.movements.opening.filter((c) => c.type !== 'reflection');
  const reqs = P.defaultFrameworkRegistry().get('gagne_9_eventos').experienceRequirements.map((r) => ({ ...r, movements: [...r.movements], anyOf: [...r.anyOf] }));
  const run = (pv) => V3.validateV3ItemArtifact({ type: 'experience', itemKey: `experience:${doc.chapterId}`, chapterId: doc.chapterId, promptVersion: pv, artifactType: 'dynamic_experience_json', experienceRequirements: reqs }, JSON.stringify(doc));
  const c6 = run('v21-exp-6').errors.map((e) => e.code);
  const c7 = run('v21-exp-7').errors.map((e) => e.code);
  assert(!c6.includes('FRAMEWORK_ELEMENT_MISSING'), 'exp-6 no exige el marco: ' + c6);
  assert(c7.includes('FRAMEWORK_ELEMENT_MISSING'), 'exp-7 lo exige: ' + c7);
});

// ── L8 ──────────────────────────────────────────────────────────────────────
check('L8 compatibilidad: sin plan, todo es byte a byte lo del código anterior (golden de 8d598b8)', () => {
  const d = L.compatDigests(distRoot, L.baseProfile());
  const diff = Object.keys(GOLDEN.digests).filter((k) => GOLDEN.digests[k] !== d[k]);
  eq(diff, [], 'huellas distintas');
  eq(Object.keys(d).sort(), Object.keys(GOLDEN.digests).sort(), 'mismas huellas medidas');
});

check('L8 un snapshot congelado con plan vuelve a validar y a recanonicalizar igual (Manifest guardado)', () => {
  const lm = L.lockAndManifest(distRoot, L.STRUCTURE, withPlan({ framework: 'gagne_9_eventos' }), 2);
  const re = snap.recanonicalizeBlueprintSnapshotV2(JSON.parse(JSON.stringify(lm.snapshot)));
  eq(snap.snapshotSha256V2(re), snap.snapshotSha256V2(lm.snapshot), 'recanonicalización');
  eq(B.validateGenerationManifestV3(JSON.parse(JSON.stringify(lm.manifest)), re, lm.source), [], 'el validador recalcula h5pType y design');
  // Un tipo de aprendizaje adulterado en el snapshot congelado falla fuerte.
  const bad = JSON.parse(JSON.stringify(lm.snapshot));
  bad.modules[0].chapters[0].design.learningType.type = 'inventado';
  throwsRe(() => snap.recanonicalizeBlueprintSnapshotV2(bad), /BLUEPRINT_PEDAGOGY_INVALID/, 'tipo adulterado');
});

// ── L9 ──────────────────────────────────────────────────────────────────────
check('L9 dry-run: cada capítulo muestra tipo, justificación, puntos y la decisión de la actividad con su regla', () => {
  const r = P.runPedagogyDryRun({ structure: L.STRUCTURE, profile: withPlan({ framework: 'teoria_demostracion_practica', chapterOverrides: { [C(8)]: { learningType: 'conceptual' }, ghost: { learningType: 'conceptual' } } }) });
  eq(r.learningPlan.framework.id, 'teoria_demostracion_practica', 'marco');
  eq(r.learningPlan.phaseLabels, true, 'TDP muestra las fases por defecto');
  eq(r.learningPlan.unknownOverrides, ['ghost'], 'override huérfano visible');
  const c1 = r.chapters.find((c) => c.chapterId === C(1));
  eq([c1.learningType.type, c1.learningType.label, c1.learningType.ruleId], ['conceptual', 'Conceptual', 'lt.conceptual.term'], 'tipo');
  assert(/Términos del capítulo: «concepto…» \(objetivo\)/.test(c1.learningType.justification), c1.learningType.justification);
  assert(c1.learningType.scores.conceptual > 0, 'puntos');
  eq([c1.activityDecision.type, c1.activityDecision.reason, c1.activityDecision.ruleId], [c1.activity.type, 'learning_type', 'la.conceptual.understand'], 'decisión de la actividad');
  assert(c1.activityDecision.rationale.length > 10, 'razón');
  const c8 = r.chapters.find((c) => c.chapterId === C(8));
  eq([c8.learningType.source, c8.learningType.suggested], ['override', 'procedimental'], 'override');
  eq(c8.activityDecision ? c8.activityDecision.ruleId : null, c8.activity.enabled ? 'la.conceptual' : null, 'la actividad sigue al override');
  assert(r.diff.summary.some((s) => /Metodología: Teoría – Demostración – Práctica/.test(s)), 'resumen');
  // Sin plan, el dry-run no trae ninguna de las claves nuevas.
  const off = P.runPedagogyDryRun({ structure: L.STRUCTURE, profile: L.baseProfile() });
  assert(off.learningPlan === undefined && off.chapters.every((c) => c.learningType === undefined && c.activityDecision === undefined), 'sin plan: sin claves nuevas');
});

check('L9b F1 (r57): la vista previa muestra el tipo del Manifest materializado (con la práctica), con el motivo; sin horas objetivo no cambia nada', () => {
  const mk = (h) => P.runPedagogyDryRun({ structure: L.STRUCTURE, profile: L.baseProfile({ targetHours: h, learningPlan: { framework: 'teoria_demostracion_practica' } }), activityTypeRules: 2 });
  // 30 h: el distribuidor agrega capítulos de práctica; el tope de ramificados (1 por 4) del curso completo mueve el escenario.
  const r30 = mk(30);
  const moved = r30.chapters.filter((c) => c.activityDecision && /mueve de/.test(c.activityDecision.rationale));
  assert(moved.length >= 1, 'hay al menos un capítulo cuya decisión cambia al materializar la práctica');
  for (const c of moved) {
    assert(c.activityDecision.type !== 'branchingscenario' || c.activityDecision.reason !== 'branching_cap', 'tipo/motivo coherentes');
    eq(c.activityDecision.reason, 'branching_cap', `${c.title}: el motivo dice que lo movió el tope`);
    assert(/curso completo/.test(c.activityDecision.rationale), 'la razón explica el movimiento');
  }
  // Sin horas objetivo no hay distribución: la decisión es la de siempre (sin texto de movimiento).
  const r0 = P.runPedagogyDryRun({ structure: L.STRUCTURE, profile: L.baseProfile({ learningPlan: { framework: 'teoria_demostracion_practica' } }), activityTypeRules: 2 });
  assert(r0.chapters.every((c) => !c.activityDecision || !/mueve de/.test(c.activityDecision.rationale)), 'sin distribución no se mueve nada');
});

check('L9 catálogo: metodologías y tipos de aprendizaje para el panel', () => {
  const svc = loadDist('modules/pedagogy/pedagogy.service.js');
  const cat = svc.PedagogyService.prototype.catalog.call({});
  eq(cat.frameworks.map((f) => f.id), ['default', 'teoria_demostracion_practica', 'gagne_9_eventos'], 'frameworks');
  eq(cat.learningTypes.map((t) => t.id), [...P.LEARNING_TYPES], 'learningTypes');
});

// ── L10 ─────────────────────────────────────────────────────────────────────
function shellFor(profile) {
  const sh = L.lockAndManifest(distRoot, L.shellStructure(), profile, 2);
  const facts = S.buildCourseFacts({ manifest: sh.manifest, blueprint: sh.snapshot, assessment: cp.defaultAssessmentProfile({ finalExam: true }), artifacts: SF.measuredArtifacts(sh.manifest) });
  return { sh, facts, all: S.assembleAllChapters(facts, SF.experiencesFor(sh.manifest), te.resolveTheme(SF.THEME_COMBOS[0])) };
}
check('L10 rótulos de fase visibles en el curso (TDP) en los bloques y en «Tu recorrido»; apagados = shell sin plan', () => {
  const on = shellFor(withPlan({ framework: 'teoria_demostracion_practica' }));
  assert(on.facts.chapters.every((c) => c.phaseLabels && c.phaseLabels.deepening === 'Teoría · Demostración'), 'facts con rótulos');
  const ch1 = on.all[0].slots.filter((s) => s.kind === 'label');
  const html = (role) => ch1.find((s) => s.role === role).html;
  assert(html('opening').includes('cvc-phase') && html('opening').includes('Teoría'), 'apertura');
  assert(html('video_primer').includes('Demostración'), 'video');
  assert(html('activity_instruction').includes('Práctica'), 'práctica');
  assert(/Presentación · Teoría/.test(html('opening')), 'recorrido con la fase');
  for (const s of on.all.flatMap((c) => c.slots)) if (s.kind === 'label') assert(vc.lintCleanSafe(s.html).ok, `CLEAN_SAFE ${s.name}`);
  const off = shellFor(withPlan({ framework: 'teoria_demostracion_practica', phaseLabels: false }));
  assert(off.facts.chapters.every((c) => c.phaseLabels === undefined), 'phaseLabels:false → sin rótulos');
  assert(!JSON.stringify(off.all).includes('cvc-phase'), 'sin chips');
  // Los rótulos son lo ÚNICO que agregan: sin los chips y sin el sufijo de fase del recorrido, el HTML es el de phaseLabels:false.
  const strip = (all) => JSON.stringify(all)
    .replace(/<div class=\\"cvc-phase\\">.*?<\/p><\/div>/g, '')
    .replace(/ · (Teoría · Demostración|Teoría|Demostración|Práctica)/g, '');
  eq(L.sha(strip(on.all)), L.sha(strip(off.all)), 'solo cambian los rótulos');
});

check('L10 huellas: mostrar/ocultar fases no regenera; cambiar un tipo de aprendizaje regenera solo ese capítulo', () => {
  const fpsOf = (prof) => {
    const lm = L.lockAndManifest(distRoot, L.STRUCTURE, prof, 2);
    const fps = FP.computeFingerprintsV3(lm.snapshot, { courseContextSha256: null });
    return new Map(lm.manifest.items.map((it) => [it.key, FP.itemFingerprintV3(fps, it.key, { ...(it.variant ? { variant: it.variant } : {}), ...(it.h5pType ? { h5pType: it.h5pType } : {}), ...(it.type === 'video_interactions' ? { videoIdentity: 'v' } : {}) })]));
  };
  const a = fpsOf(withPlan({ framework: 'default' }));
  const b = fpsOf(withPlan({ framework: 'default', phaseLabels: true }));
  eq([...a.keys()].filter((k) => a.get(k) !== b.get(k)), [], 'phaseLabels no cambia huellas');
  const c = fpsOf(withPlan({ framework: 'default', chapterOverrides: { [C(8)]: { learningType: 'conceptual' } } }));
  const changed = [...a.keys()].filter((k) => a.get(k) !== c.get(k));
  // Lo del capítulo 8, más lo que ya dependía de su diseño (la presentación de su módulo y el examen final): ningún otro capítulo.
  assert(changed.length > 0 && changed.every((k) => k.endsWith(C(8)) || k === `module_intro:${M(3)}` || k.startsWith('final_exam:')), 'solo el capítulo 8 y sus dependientes: ' + JSON.stringify(changed));
  assert(changed.some((k) => k === `content:${C(8)}`), 'el contenido del capítulo 8 se regenera');
  const off = fpsOf(L.baseProfile());
  assert([...a.keys()].some((k) => a.get(k) !== off.get(k)), 'activar el plan sí regenera (el diseño cambia)');
});

// ── L11 ─────────────────────────────────────────────────────────────────────
check('L11 espejo del ejecutor (vendor 45 = frontend): mismos errores del marco que el backend sobre los mismos documentos', () => {
  const fs = require('fs');
  const vm = require('vm');
  const dir = process.env.CURSIA_FRONTEND_REPO ? path.join(process.env.CURSIA_FRONTEND_REPO, 'src/js') : path.join(__dirname, '..', 'vendor', 'dynamic-executor');
  const ctx = { console: { log() {}, warn() {}, error() {} } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, '44-dynamic-prompt-builders.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, '45-dynamic-generation-executor.js'), 'utf8') + '\n;this.__fw = dynValidateFrameworkRequirementsV3; this.__pv = _dynExperiencePromptVersion;', ctx);
  const reqSets = P.defaultFrameworkRegistry().list().map((f) => f.experienceRequirements).concat([[{ id: 'x.any', movements: ['synthesis', 'closing'], anyOf: ['checklist', 'summary_visual'], message: 'm' }]]);
  const base = experienceDoc();
  const docs = [base];
  for (const m of ['opening', 'deepening', 'closing']) {
    const d = JSON.parse(JSON.stringify(base));
    d.movements[m] = d.movements[m].slice(0, 1);
    docs.push(d);
  }
  let n = 0;
  for (const reqs of reqSets) {
    for (const d of docs) {
      const be = vc.validateFrameworkRequirements(d, reqs).map((e) => [e.path, e.code, e.message]);
      const fe = JSON.parse(JSON.stringify(ctx.__fw(d, reqs))).map((e) => [e.path, e.code, e.message]);
      eq(fe, be, `paridad (${reqs.map((r) => r.id).join(',')})`);
      n += be.length;
    }
  }
  assert(n > 0, 'los vectores ejercitan errores');
  // Versión del prompt que reporta el ejecutor = la que el backend usa para exigir los requisitos.
  const item = (reqs) => ({ itemKey: 'experience:x', claimPayload: { experienceFeatures: { eduFields: true } }, pedagogy: reqs ? { experienceRequirements: reqs } : undefined });
  eq([ctx.__pv(item(null)), ctx.__pv(item(reqSets[2]))], ['v21-exp-6', 'v21-exp-7'], 'versiones');
  assert(V3.frameworkRequirementsApply(ctx.__pv(item(reqSets[2]))) && !V3.frameworkRequirementsApply(ctx.__pv(item(null))), 'gate coherente');
});

console.log(`\n${failed === 0 ? '✅' : '❌'} check-learning-plan: ${passed} OK, ${failed} fallidas`);
process.exit(failed === 0 ? 0 : 1);
