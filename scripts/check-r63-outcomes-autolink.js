#!/usr/bin/env node
/* eslint-disable */
// r63 · Coherencia académica automática en cursos SIN documento. Contra dist/. USD 0: sin proveedores, sin IA, red bloqueada.
//
// Parte pura:
//   OA1 normalización: los resultados del perfil (saber, saber hacer, competencias) pasan al modelo de resultados con ids
//       estables RA1…/CO1…, `provided`, dominio del perfil; idempotente (mismo perfil → sin cambios, mismo sha)
//   OA2 resultados repetidos (mayúsculas, tildes, puntuación; entre saber / saber hacer / competencias): no se duplican
//   OA3 ids estables al editar el perfil: lo que no cambió conserva su id; lo nuevo toma el siguiente libre (nunca uno que
//       el puente ya usó); lo que el puente agregó y el docente quitó se quita; lo editado en el contexto o propuesto por
//       Cursia no se toca
//   OA4 con documento: el documento manda (no cambia nada: mismo contexto, mismo sha); lo que el perfil trae de más se
//       informa (`ignored`), lo repetido del documento no
//   OA5 vínculos del caso R1 (1 módulo × 2 capítulos): RA1 → Cap. 1, RA2 → Cap. 2, CO1 transversal → ambos
//   OA6 sin coincidencia clara: el resultado queda ambiguo y no se vincula; un capítulo que no encaja queda sin vínculos
//       (ni siquiera la competencia: se revisa)
//   OA7 varios capítulos (2 módulos × 3): cada resultado a su capítulo; uno que abarca dos capítulos va a los dos
//   OA8 competencias transversales: a todos los capítulos con resultado; sin resultados, a todos los capítulos
//   OA9 se respetan los vínculos del docente (no se pisan; cuentan para la cobertura) y los capítulos no elegibles
//   OA10 verificación: A1c (competencia) se corrige sola si la vinculación la incluye; casos ambiguos → «Requiere revisión»
//   OA11 ninguna ruta llama a la IA (sin red; el módulo no importa clientes de proveedores)
//   OA12 stemmer liviano: contexto ≠ contenido, comunidad ≠ comunicación, control ≠ contrato…; leyes = ley, activación = activar
//   OA13 falsos positivos (review): prefijos que colisionan y términos de todo el curso («seguridad en obra», «gestión»,
//        «empresa») no vinculan → ambiguo / capítulo para revisión
//   OA14 plurales («leyes» ↔ «ley») vinculan; sinónimos (RCP / reanimación, infarto / ataque cardíaco) quedan ambiguos
//   OA15 capítulo integrador vinculado a medias → aviso «quizá también trabaja», sin vínculo forzado
//   OA16 guardar el perfil solo agrega; perfil vaciado → se quita lo del puente (no lo ajeno)
//   OA17 el verbo inicial no cuenta solo: «Calcula el costo de la nómina» y «Aplica la normativa ambiental» → ambiguos
//   OA18 stemmer: planea = planeación, costeo = costo; marco ≠ marca, medio ≠ media, cargo ≠ carga, informe ≠ información
//   OA19 recall: un título corto entero dentro del resultado vincula; evidencia que no distingue dos resultados → revisión
// Parte DB (Postgres 16 desechable; --pure-only la salta y lo dice):
//   OD1 caso R1 exacto, curso sin documento: al guardar el perfil queda el contexto (RA1, RA2, CO1) sin subir el contador;
//       «Usar este diseño» lo vincula solo (RA1 → Cap. 1, RA2 → Cap. 2, CO1 → ambos) con la misma huella; el perfil
//       pedagógico no cambia de versión; la verificación: 2 de 2 · 1 de 1, sin críticos ni nada pendiente; evaluaciones
//       alineadas (exámenes del módulo y final evidencian RA1 y RA2)
//   OD2 idempotente: re-guardar el mismo perfil no crea versiones ni sube el contador
//   OD3 capítulos creados después del perfil: «Cursia recomienda» lo muestra (vista previa sin escribir) y «Usar este
//       diseño» (design/fix link_outcomes) vincula; un curso anterior (perfil sin contexto) también, sin re-guardar nada
//   OD4 curso con documento: el comportamiento de siempre (sin versión nueva del contexto, sin vínculos nuevos)
//   OD5 perfil y después documento: el documento reemplaza; los vínculos a ids del perfil que cambian de significado se
//       quitan; los resultados del documento no se duplican
//   OD6 Prebrief: GET /prebrief NO escribe; «Preparar» con huella vieja falla sin escribir nada (re-review M-C); con el
//       curso listo, «Preparar» corre DE VERDAD con la huella de la vista previa y guarda contexto y vínculos; el
//       Blueprint congelado los lleva (sha verificado); después nada lo cambia
//   OD8 un resultado del perfil sin capítulo claro: advertencia «Requiere revisión», no bloquea el Prebrief
//   OD9 quitar del perfil un resultado vinculado: el guardado no sube el contador; «Usar este diseño» con el contador de
//       la interfaz no da 409 y devuelve el vigente
//   OD10 «Crear desde cero» (contexto propuesto sin unidades): vista previa, vínculos y ambiguo como advertencia
//   OD7 regresión: un Blueprint congelado ANTES (sin contexto) no cambia; con una propuesta lista/aprobada o una
//       producción en curso no se toca nada automáticamente
//
// Uso: node scripts/check-r63-outcomes-autolink.js [--pure-only] [path/to/dist]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
function loadDist(rel) {
  try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${err.message}`); process.exit(1); }
}

// Red: solo loopback (el Postgres desechable). Cualquier otro destino falla y se cuenta.
const netAttempts = [];
{
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) {
    const o = typeof a[0] === 'object' && a[0] ? a[0] : { port: a[0], host: typeof a[1] === 'string' ? a[1] : undefined };
    const host = o.host || (o.path ? 'unix' : 'localhost');
    if (!['127.0.0.1', 'localhost', '::1', 'unix'].includes(host)) { netAttempts.push(`${host}:${o.port}`); throw new Error(`red prohibida: ${host}`); }
    return origConnect.apply(this, a);
  };
  globalThis.fetch = () => { netAttempts.push('fetch'); throw new Error('red prohibida: fetch'); };
}

const A = loadDist('modules/academic-context/index.js');
const V = loadDist('modules/course-design/design-verification.js');
const PP = loadDist('modules/pedagogy/pedagogy-profile.js');
const CP = loadDist('modules/course-profiles/course-profiles.js');
const F = require('./lib/academic-fixtures.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };

// Caso R1 (curso #1567, sintético): textos exactos del perfil y de la estructura.
const R1 = {
  RA1: 'Identifica los pasos de la cadena de emergencia en el lugar de trabajo',
  RA2: 'Aplica la atención inicial a heridas y quemaduras leves sin poner en riesgo su propia seguridad',
  CO1: 'Actúa de forma segura ante una emergencia en el lugar de trabajo',
  module: { title: 'Primera respuesta ante emergencias', objective: 'Responder de forma segura ante una emergencia en el lugar de trabajo' },
  chapters: [
    { title: 'Evaluación de la escena y activación de la emergencia', objective: 'Evaluar la seguridad de la escena y activar la cadena de emergencia' },
    { title: 'Atención inicial de heridas y quemaduras leves', objective: 'Aplicar la atención inicial a heridas y quemaduras leves sin ponerse en riesgo' },
  ],
};
const profileOf = (lo, extra = {}) => {
  const p = PP.emptyPedagogicalProfile();
  return { ...p, learner: { ...p.learner, description: 'Personal de oficina y de planta sin formación previa en primeros auxilios' }, learningOutcomes: { know: [], do: [], competencies: [], ...lo }, ...extra };
};
const R1_PROFILE = profileOf({ know: [R1.RA1], do: [R1.RA2], competencies: [R1.CO1] });
const ch = (id, title, objective, outcomeIds = [], eligible = true) => ({ id, title, objective, description: null, outcomeIds, eligible });
const linksOf = (plan) => Object.fromEntries(plan.links.map((l) => [l.chapterId, l.suggested]));
const sha = (ctx) => CP.profileSha256(CP.normalizeProfile('academic', ctx));

(async () => {
  console.log('Parte pura');

  await check('OA1 normalización determinista: RA1/RA2/CO1 con ids estables, provided, dominio del perfil; idempotente', () => {
    const r = A.academicContextFromProfile(null, R1_PROFILE, null);
    eq([r.action, r.added, r.removed], ['create', ['RA1', 'RA2', 'CO1'], []], 'crea');
    eq(r.context.outcomes.map((o) => [o.id, o.text, o.domain, o.level, o.status]), [['RA1', R1.RA1, 'know', 'remember', 'provided'], ['RA2', R1.RA2, 'do', 'apply', 'provided']], 'resultados');
    eq(r.context.competencies.map((c) => [c.id, c.text, c.status]), [['CO1', R1.CO1, 'provided']], 'competencias');
    eq(r.context.documents, [], 'sin documentos');
    eq(CP.validateProfile('academic', r.context, { finalExam: true }), [], 'contexto válido');
    const again = A.academicContextFromProfile(CP.normalizeProfile('academic', r.context), R1_PROFILE, r.record);
    eq([again.action, again.added, again.removed], ['none', [], []], 'mismo perfil → sin cambios');
    eq(sha(again.context), sha(r.context), 'mismo sha');
    // Determinista: dos corridas, el mismo resultado byte a byte.
    eq(JSON.stringify(A.academicContextFromProfile(null, R1_PROFILE, null)), JSON.stringify(r), 'determinista');
    // La derivación de vuelta al perfil no cambia nada (mismos saber / saber hacer / competencias).
    const back = A.suggestProfileFromContext(r.context, PP.normalizePedagogicalProfile(R1_PROFILE));
    eq(back.changes, [], 'la derivación al perfil no tiene cambios');
  });

  await check('OA2 resultados repetidos: por texto normalizado, también entre saber / saber hacer / competencias', () => {
    const p = profileOf({ know: [R1.RA1, '  identifica los PASOS de la cadena de emergencia en el lugar de trabajo. '], do: [R1.RA1.replace('Identifica', 'IDENTIFICA'), R1.RA2], competencies: [R1.CO1, 'Actua de forma segura ante una emergencia en el lugar de trabajo!', R1.RA2] });
    const r = A.academicContextFromProfile(null, p, null);
    eq([r.context.outcomes.map((o) => o.id), r.context.competencies.map((c) => c.id)], [['RA1', 'RA2'], ['CO1']], 'sin duplicados');
    eq(r.duplicates.length, 4, 'los repetidos se informan: ' + JSON.stringify(r.duplicates));
    eq(A.normalizeOutcomeText('Árbol, NIÑO;  ¿qué?'), 'arbol nino que', 'normalización');
  });

  await check('OA3 ids estables: conserva, agrega con el siguiente libre, quita lo del puente, no toca lo ajeno ni lo editado', () => {
    const r1 = A.academicContextFromProfile(null, R1_PROFILE, null);
    // El docente agrega un resultado (saber hacer) y quita RA1 del perfil.
    const RA3 = 'Utiliza el botiquín de primeros auxilios del lugar de trabajo';
    const p2 = profileOf({ know: [], do: [R1.RA2, RA3], competencies: [R1.CO1] });
    const r2 = A.academicContextFromProfile(r1.context, p2, r1.record);
    eq([r2.action, r2.added, r2.removed], ['update', ['RA3'], ['RA1']], 'agrega RA3 y quita RA1');
    eq(r2.context.outcomes.map((o) => [o.id, o.text]), [['RA2', R1.RA2], ['RA3', RA3]], 'RA2 conserva su id');
    // Vuelve a agregar el texto de RA1: id nuevo (RA4), nunca RA1 (el puente ya lo usó).
    const r3 = A.academicContextFromProfile(r2.context, profileOf({ know: [R1.RA1], do: [R1.RA2, RA3], competencies: [R1.CO1] }), r2.record);
    eq([r3.added, r3.context.outcomes.map((o) => o.id)], [['RA4'], ['RA2', 'RA3', 'RA4']], 'id nuevo, nunca reutilizado');
    // Un resultado propuesto por Cursia (no del puente) y uno editado en «Lo que entendimos» no se quitan.
    const proposed = A.buildProposedContext(null, { outcomes: ['Describe la cadena de emergencia'], competencies: [] });
    const r4 = A.academicContextFromProfile(proposed, profileOf({ do: [R1.RA2] }), null);
    eq([r4.removed, r4.context.outcomes.map((o) => o.id)], [[], ['RA1', 'RA2']], 'lo propuesto se conserva y lo nuevo sigue la numeración');
    const edited = JSON.parse(JSON.stringify(r1.context));
    edited.outcomes[0].text = 'Identifica y activa la cadena de emergencia';
    const r5 = A.academicContextFromProfile(edited, profileOf({ do: [R1.RA2], competencies: [R1.CO1] }), r1.record);
    eq([r5.removed, r5.context.outcomes.map((o) => o.id)], [[], ['RA1', 'RA2']], 'lo editado en el contexto ya no es del puente: no se quita');
  });

  const doc = (await A.extractAcademicContext([{ name: 'micro.docx', data: await F.fixture('consistent', 'docx') }])).context;

  await check('OA4 con documento: el documento manda; nada cambia; lo de más se informa, lo repetido no', () => {
    const before = sha(doc);
    const same = doc.outcomes[0].text.toUpperCase() + '.';
    const extra = 'Explica la importancia de los costos en la toma de decisiones gerenciales';
    const r = A.academicContextFromProfile(doc, profileOf({ know: [same, extra], competencies: [doc.competencies[0].text] }), null);
    eq([r.action, r.reason, r.added], ['skip', 'DOCUMENT_CONTEXT', []], 'no hace nada');
    eq(sha(r.context), before, 'mismo contexto, mismo sha');
    eq(r.ignored, [extra], 'solo lo que el documento no trae');
    assert(!A.isDocumentlessContext(doc), 'un documento no es «sin documento»');
  });

  await check('OA5 caso R1: RA1 → Cap. 1, RA2 → Cap. 2, CO1 → ambos; con umbral y sin ambiguos', () => {
    const ctx = A.academicContextFromProfile(null, R1_PROFILE, null).context;
    const plan = A.planDocumentlessLinks(ctx, R1.chapters.map((c, i) => ch(`c${i + 1}`, c.title, c.objective)));
    eq(linksOf(plan), { c1: ['RA1', 'CO1'], c2: ['RA2', 'CO1'] }, 'vínculos');
    eq([plan.ambiguous, plan.unmatchedChapterIds], [[], []], 'sin ambiguos');
    const s = (o, c) => plan.scores.find((x) => x.outcomeId === o && x.chapterId === c);
    assert(s('RA1', 'c1').score >= A.LINK_SCORE_MIN && s('RA1', 'c2').score === 0, 'RA1: cadena + emergencia en Cap. 1, nada en Cap. 2');
    assert(s('RA2', 'c2').score > 0.6 && s('RA2', 'c1').score < A.LINK_SCORE_MIN, 'RA2: Cap. 2 claro; Cap. 1 solo comparte «seguridad»');
    // El mismo plan en suggestOutcomeLinks (el panel académico y la vinculación de siempre).
    const sug = A.suggestOutcomeLinks(ctx, R1.chapters.map((c, i) => ({ id: `c${i + 1}`, moduleId: 'm', title: c.title, objective: c.objective, outcomeIds: null })));
    eq(sug.map((x) => [x.status, x.suggested]), [['inferred', ['RA1', 'CO1']], ['inferred', ['RA2', 'CO1']]], 'suggestOutcomeLinks usa el mismo plan sin documento');
  });

  await check('OA6 sin coincidencia clara: ambiguo («requiere revisión»), nunca un vínculo forzado', () => {
    const RA3 = 'Reconoce la normativa de seguridad social vigente';
    const ctx = A.academicContextFromProfile(null, profileOf({ know: [R1.RA1, RA3], do: [R1.RA2], competencies: [R1.CO1] }), null).context;
    const chapters = [...R1.chapters.map((c, i) => ch(`c${i + 1}`, c.title, c.objective)), ch('c3', 'Ergonomía en la oficina', 'Ajustar la silla y la pantalla del puesto')];
    const plan = A.planDocumentlessLinks(ctx, chapters);
    const ra3 = ctx.outcomes.find((o) => o.text === RA3).id; // saber va primero: RA2
    eq(plan.ambiguous.map((a) => a.id), [ra3], 'el resultado sin capítulo claro queda ambiguo');
    assert(plan.ambiguous[0].score < A.LINK_SCORE_MIN, 'su mejor coincidencia no alcanza el umbral');
    assert(!plan.links.some((l) => l.suggested.includes(ra3)), 'no se vincula');
    eq(plan.unmatchedChapterIds, ['c3'], 'el capítulo que no encaja se revisa');
    assert(!plan.links.some((l) => l.chapterId === 'c3'), 'ni siquiera la competencia (ocultaría el hueco)');
    // Un solo término en común (y bajo) tampoco alcanza.
    const weak = A.planDocumentlessLinks(A.academicContextFromProfile(null, profileOf({ know: ['Reconoce la seguridad vial'] }), null).context, [ch('x', 'Seguridad informática', 'Proteger contraseñas y equipos')]);
    eq(weak.ambiguous.map((a) => a.id), ['RA1'], 'una palabra suelta no es un vínculo');
  });

  await check('OA7 varios capítulos (2 × 3): cada resultado a su capítulo; uno que abarca dos va a los dos', () => {
    const lo = {
      know: ['Identifica los tipos de extintores y sus clases de fuego', 'Reconoce las señales de evacuación del edificio'],
      do: ['Aplica la reanimación cardiopulmonar en un adulto', 'Realiza el vendaje de heridas y la inmovilización de fracturas'],
      competencies: ['Actúa con calma y seguridad ante una emergencia'],
    };
    const ctx = A.academicContextFromProfile(null, profileOf(lo), null).context;
    const chapters = [
      ch('m1c1', 'Clases de fuego y extintores', 'Elegir el extintor según la clase de fuego'),
      ch('m1c2', 'Rutas y señales de evacuación', 'Seguir las señales de evacuación del edificio'),
      ch('m1c3', 'Simulacro de evacuación con extintores', 'Combinar evacuación y uso de extintores en un simulacro'),
      ch('m2c1', 'Reanimación cardiopulmonar en adultos', 'Ejecutar compresiones de reanimación cardiopulmonar'),
      ch('m2c2', 'Vendaje de heridas', 'Vendar heridas abiertas'),
      ch('m2c3', 'Inmovilización de fracturas', 'Inmovilizar fracturas de brazo y pierna'),
    ];
    const plan = A.planDocumentlessLinks(ctx, chapters);
    const L = linksOf(plan);
    eq(L.m1c1, ['RA1', 'CO1'], 'extintores');
    eq(L.m1c2, ['RA2', 'CO1'], 'evacuación');
    eq(L.m2c1, ['RA3', 'CO1'], 'RCP');
    assert(L.m2c2.includes('RA4') && L.m2c3.includes('RA4'), 'RA4 abarca vendaje e inmovilización: ' + JSON.stringify(L));
    // El simulacro integra evacuación y extintores, pero comparte un solo término con cada resultado: no se fuerza, se revisa.
    eq([L.m1c3, plan.unmatchedChapterIds, plan.ambiguous], [undefined, ['m1c3'], []], 'capítulo integrador sin coincidencia confiable → revisión');
  });

  await check('OA8 competencias transversales: a todos los capítulos con resultado; sin resultados, a todos', () => {
    const only = A.academicContextFromProfile(null, profileOf({ competencies: [R1.CO1, 'Trabaja en equipo durante la emergencia'] }), null).context;
    const plan = A.planDocumentlessLinks(only, R1.chapters.map((c, i) => ch(`c${i + 1}`, c.title, c.objective)));
    eq(linksOf(plan), { c1: ['CO1', 'CO2'], c2: ['CO1', 'CO2'] }, 'sin resultados, la competencia va a todos');
  });

  await check('OA9 vínculos del docente intactos (y cuentan para la cobertura); capítulos no elegibles fuera', () => {
    const ctx = A.academicContextFromProfile(null, R1_PROFILE, null).context;
    const plan = A.planDocumentlessLinks(ctx, [ch('c1', R1.chapters[0].title, R1.chapters[0].objective, ['RA2']), ch('c2', R1.chapters[1].title, R1.chapters[1].objective), ch('p', 'Práctica: atención inicial de heridas y quemaduras leves', null, [], false)]);
    // c1 lo decidió el docente (RA2): no se toca. RA2 ya está cubierto → c2 toma RA2 por el sentido capítulo → resultado.
    eq(linksOf(plan), { c2: ['RA2', 'CO1'] }, 'solo el capítulo sin vínculos (la práctica no)');
    // RA1 encaja con Cap. 1, que vinculó el docente: no se le agrega nada (el Coherence Engine lo marca como sin capítulo).
    assert(!plan.links.some((l) => l.chapterId === 'c1'), 'el capítulo del docente no se toca');
  });

  await check('OA10 verificación: A1c se corrige sola si la vinculación la incluye; ambiguos → «Requiere revisión»', () => {
    const base = { status: 'within_tolerance', targetHours: 10, estimatedHours: 10, toleranceHours: 1, baseHours: 5, counts: { modules: 1, chapters: 2, contentChapters: 2, practiceChapters: 0, videoChapters: 2, activities: 2, applicationActivities: 2, evaluations: 2 },
      manifestErrors: [], approach: { id: 'competencias', label: 'Competencias' }, policyKind: 'application_first', audiovisual: 'recommended', pinnedChapters: 0, cost: { min: '1', expected: '2', max: '3' },
      preferences: { emphasis: 'balanced', applicationActivities: 'auto' }, proposedChapterIds: [], uncoveredContents: [], requiredEvaluations: [], uncoveredEvaluations: [] };
    const al = { available: true, outcomes: [{ id: 'RA1', status: 'uncovered', domain: 'know' }, { id: 'CO1', status: 'uncovered', domain: 'competency' }],
      findings: [{ id: 'f1', rule: 'A1', severity: 'critical', outcomeIds: ['RA1'], chapterIds: [], message: 'RA1 sin capítulo', suggestion: '' }, { id: 'f2', rule: 'A1c', severity: 'warning', outcomeIds: ['CO1'], chapterIds: [], message: 'competencia CO1 sin capítulo', suggestion: '' }] };
    const v = V.verifyDesign({ ...base, alignment: al, autoLink: { chapterIds: ['c1'], outcomeIds: ['RA1', 'CO1'], preview: [{ chapter: 'Cap', outcomes: ['RA1', 'CO1'] }], review: { outcomes: [], chapters: [] } } });
    const byId = Object.fromEntries(v.checks.map((c) => [c.id, c]));
    eq(byId['alignment:f2'].fix.kind, 'auto', 'A1c automática');
    eq(byId['alignment:f1'].fix.kind, 'auto', 'A1 automática');
    assert(!byId.outcome_review, 'sin ambiguos no hay revisión');
    const v2 = V.verifyDesign({ ...base, alignment: al, autoLink: { chapterIds: [], outcomeIds: [], preview: [], review: { outcomes: [{ id: 'RA1', text: 'x' }], chapters: [{ chapterId: 'c9', title: 'Ergonomía' }] } } });
    const r = v2.checks.find((c) => c.id === 'outcome_review');
    assert(r && r.severity === 'warning' && /^Requiere revisión/.test(r.title) && /RA1/.test(r.detail) && /Ergonomía/.test(r.detail) && r.fix.kind === 'editor', 'revisión: ' + JSON.stringify(r));
    eq(v2.checks.find((c) => c.id === 'alignment:f2').fix.kind, 'editor', 'sin vinculación que la incluya, A1c sigue en el editor');
    // Decisión del controlador: sin documento, el resultado ambiguo es advertencia («Requiere revisión»), no bloquea.
    eq([v2.checks.find((c) => c.id === 'alignment:f1').severity, v2.blocking], ['warning', false], 'A1 de un resultado ambiguo → advertencia, sin bloqueo');
    eq(v2.checks.find((c) => c.id === 'outcomes').severity, 'warning', 'el resumen de resultados tampoco es crítico');
    // Con documento la verificación no cambia: sin `review`, sin revisión; A1c al editor si la vinculación no la incluye.
    const v3 = V.verifyDesign({ ...base, alignment: al, autoLink: { chapterIds: ['c1'], outcomeIds: ['RA1'], preview: [{ chapter: 'Cap', outcomes: ['RA1'] }] } });
    assert(!v3.checks.some((c) => c.id === 'outcome_review') && v3.checks.find((c) => c.id === 'alignment:f2').fix.kind === 'editor', 'con documento, lo de siempre');
    const v4 = V.verifyDesign({ ...base, alignment: al, autoLink: { chapterIds: [], outcomeIds: [], preview: [] } });
    eq([v4.checks.find((c) => c.id === 'alignment:f1').severity, v4.blocking], ['critical', true], 'con documento (sin `review`), A1 sigue crítico como siempre');
  });

  await check('OA11 sin IA: los módulos nuevos no importan clientes de proveedores', () => {
    for (const f of ['src/modules/academic-context/profile-outcomes.ts', 'src/modules/academic-context/profile-outcomes-db.ts']) {
      const t = fs.readFileSync(path.join(REPO, f), 'utf8');
      assert(!/anthropic|openai|fetch\(|axios|https?\.request|transcrib|llm/i.test(t.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), `${f} no llama a proveedores`);
    }
  });

  await check('OA12 raíces (stemmer liviano): prefijos distintos no colisionan; plurales y derivados sí coinciden', () => {
    const st = (w) => A.lightStem(w);
    for (const [a, b] of [['contexto', 'contenido'], ['comunidad', 'comunicacion'], ['control', 'contrato'], ['informacion', 'informatica'], ['interno', 'internet'], ['proceso', 'procedimiento'], ['estado', 'estadistica']]) {
      assert(st(a) !== st(b), `${a} ≠ ${b}: ${st(a)} / ${st(b)}`);
    }
    for (const [a, b] of [['activacion', 'activar'], ['emergencia', 'emergencias'], ['leyes', 'ley'], ['redes', 'red'], ['luces', 'luz'], ['gestion', 'gestiona'], ['aplicar', 'aplica'], ['seguridad', 'seguro']]) {
      eq(st(a), st(b), `${a} = ${b}`);
    }
  });

  await check('OA13 falsos positivos (review I1/I2): prefijos que colisionan y términos de todo el curso no vinculan → ambiguo', () => {
    const one = (lo, chapters) => A.planDocumentlessLinks(A.academicContextFromProfile(null, profileOf(lo), null).context, chapters);
    const p1 = one({ know: ['Comprende el contexto de la comunidad'] }, [ch('a', 'Contenido y comunicación', 'Organizar el contenido de la comunicación interna'), ch('b', 'Presupuesto anual', 'Calcular el presupuesto')]);
    eq([p1.links, p1.ambiguous.map((x) => x.id)], [[], ['RA1']], 'contexto/comunidad ≠ contenido/comunicación');
    const obra = [ch('o1', 'Seguridad en obra: primeros auxilios', 'Atender lesiones leves en la obra con seguridad'), ch('o2', 'Seguridad en obra: andamios y alturas', 'Montar andamios con seguridad en la obra'), ch('o3', 'Seguridad en obra: excavaciones', 'Entibar excavaciones con seguridad en la obra')];
    const p2 = one({ know: ['Identifica los riesgos de seguridad en obra'] }, obra);
    eq([p2.links, p2.ambiguous.map((x) => x.id), p2.unmatchedChapterIds], [[], ['RA1'], ['o1', 'o2', 'o3']], '«seguridad» y «obra» están en todos los capítulos: no cuentan');
    const gest = [ch('g1', 'Gestión financiera de la empresa', 'Leer los estados financieros de la empresa'), ch('g2', 'Gestión del talento humano en la empresa', 'Seleccionar y retener el talento humano')];
    const p3 = one({ do: ['Gestiona el talento humano de la empresa', 'Gestiona el presupuesto de la empresa'] }, gest);
    eq(linksOf(p3), { g2: ['RA1'] }, 'talento humano → su capítulo; «gestión» y «empresa» no deciden');
    eq(p3.ambiguous.map((x) => x.id), ['RA2'], 'el presupuesto no tiene capítulo claro (no se fuerza a «Gestión financiera»)');
    eq(p3.unmatchedChapterIds, ['g1'], '«Gestión financiera» queda para revisión');
  });

  await check('OA14 plurales y sinónimos: «leyes» ↔ «ley» vincula; RCP / reanimación e infarto / ataque cardíaco quedan ambiguos', () => {
    const one = (lo, chapters) => A.planDocumentlessLinks(A.academicContextFromProfile(null, profileOf(lo), null).context, chapters);
    const p1 = one({ do: ['Aplica las leyes laborales vigentes'] }, [ch('l', 'La ley laboral colombiana', 'Conocer la ley laboral'), ch('x', 'Nómina mensual', 'Liquidar la nómina')]);
    eq(linksOf(p1), { l: ['RA1'] }, 'leyes laborales ↔ ley laboral');
    const p2 = one({ do: ['Aplica la RCP en un adulto'], know: ['Reconoce los signos de un infarto'] }, [ch('r', 'Reanimación cardiopulmonar', 'Hacer compresiones torácicas'), ch('i', 'Ataque cardíaco', 'Actuar ante un ataque cardíaco')]);
    eq([p2.links, p2.ambiguous.map((x) => x.id).sort()], [[], ['RA1', 'RA2']], 'sin sinónimos inventados: ambiguo');
  });

  await check('OA15 capítulo integrador vinculado a medias: aviso «quizá también trabaja» (review M2), sin vínculo forzado', () => {
    const ctx = A.academicContextFromProfile(null, profileOf({ do: ['Calcula los costos de producción de un producto', 'Determina el punto de equilibrio de la empresa'] }), null).context;
    const p = A.planDocumentlessLinks(ctx, [ch('c', 'Costos de producción', 'Clasificar los costos de producción'), ch('e', 'Punto de equilibrio', 'Calcular el punto de equilibrio'), ch('i', 'Caso integrador: punto de equilibrio con costos', 'Resolver un caso de punto de equilibrio')]);
    const L = linksOf(p);
    eq([L.c, L.e], [['RA1'], ['RA2']], 'cada resultado en su capítulo');
    eq(L.i, ['RA2'], 'el integrador recibe el que le encaja casi igual');
    assert(p.partial.some((x) => x.chapterId === 'i' && x.outcomeIds.includes('RA1')), 'y avisa que quizá también trabaja RA1: ' + JSON.stringify(p.partial));
    assert(!p.links.some((l) => l.chapterId === 'i' && l.suggested.includes('RA1')), 'sin vincularlo');
    const v = V.verifyDesign({ status: 'within_tolerance', targetHours: 10, estimatedHours: 10, toleranceHours: 1, baseHours: 5, counts: { modules: 1, chapters: 3, contentChapters: 3, practiceChapters: 0, videoChapters: 3, activities: 3, applicationActivities: 3, evaluations: 2 },
      manifestErrors: [], approach: null, policyKind: null, audiovisual: 'recommended', pinnedChapters: 0, cost: null, preferences: { emphasis: 'balanced', applicationActivities: 'auto' }, proposedChapterIds: [], uncoveredContents: [], requiredEvaluations: [], uncoveredEvaluations: [],
      alignment: { available: true, outcomes: [], findings: [] }, autoLink: { chapterIds: [], outcomeIds: [], preview: [], review: { outcomes: [], chapters: [], partial: [{ chapterId: 'i', title: 'Caso integrador', outcomeIds: ['RA1'] }] } } });
    const r = v.checks.find((x) => x.id === 'outcome_review');
    assert(r && r.severity === 'warning' && /quizá también trabaja RA1/.test(r.detail), 'aviso: ' + JSON.stringify(r));
  });

  await check('OA16 guardar el perfil solo agrega (sin podar ni subir el contador); perfil vaciado: se quita lo del puente (review I4/M4)', () => {
    const r1 = A.academicContextFromProfile(null, R1_PROFILE, null);
    const onlyAdd = A.academicContextFromProfile(r1.context, profileOf({ do: [R1.RA2] }), r1.record, { allowRemovals: false });
    eq([onlyAdd.action, onlyAdd.removed], ['none', []], 'el guardado del perfil no quita (eso poda vínculos)');
    const emptied = A.academicContextFromProfile(r1.context, profileOf({}), r1.record);
    eq([emptied.action, emptied.removed, emptied.context.outcomes.length, emptied.context.competencies.length], ['update', ['RA1', 'RA2', 'CO1'], 0, 0], 'perfil vaciado: se quitan RA1, RA2 y CO1 del puente');
    const foreign = A.academicContextFromProfile(A.buildProposedContext(null, { outcomes: ['Describe la cadena de emergencia'] }), profileOf({}), null);
    eq([foreign.action, foreign.reason], ['skip', 'NO_PROFILE_OUTCOMES'], 'sin registro del puente no se quita nada ajeno');
  });

  await check('OA17 el verbo inicial no cuenta solo (re-review I-A): «Calcula el costo de la nómina» y «Aplica la normativa ambiental» quedan ambiguos', () => {
    const one = (lo, chapters) => A.planDocumentlessLinks(A.academicContextFromProfile(null, profileOf(lo), null).context, chapters);
    const v2 = one({ do: ['Calcula el costo de la nómina'] }, [ch('a', 'Costo de ventas', 'Calcular el costo de ventas'), ch('b', 'Liquidación de la nómina', 'Liquidar la nómina y sus prestaciones'), ch('c', 'Impuestos', 'Declarar impuestos')]);
    eq([v2.links, v2.ambiguous.map((x) => x.id)], [[], ['RA1']], 'nómina: no vincula con «Costo de ventas» por «calcular» + «costo»');
    const v3 = one({ do: ['Aplica la normativa ambiental', 'Diseña un plan de residuos'] }, [ch('a', 'Aplicación de la normativa laboral', 'Aplicar el código laboral'), ch('b', 'Gestión ambiental', 'Diseñar un plan de manejo ambiental')]);
    assert(!v3.links.some((l) => l.chapterId === 'a'), 'ambiental: no vincula con «normativa laboral»: ' + JSON.stringify(v3.links));
    assert(v3.ambiguous.some((x) => x.text === 'Aplica la normativa ambiental'), 'ambiental: queda ambiguo');
    const v1 = one({ do: ['Evalúa el riesgo de crédito de un cliente'] }, [ch('a', 'Evaluación del riesgo operativo', 'Evaluar el riesgo operativo de la empresa'), ch('b', 'Crédito y cartera', 'Otorgar crédito a clientes'), ch('c', 'Liquidez', 'Medir la liquidez')]);
    assert(!v1.links.some((l) => l.chapterId === 'a'), 'crédito: no a «riesgo operativo» por el verbo: ' + JSON.stringify(v1.links));
    eq(A.leadVerbStem('El estudiante será capaz de calcular el costo'), A.lightStem('calcular'), 'el verbo se encuentra después de «será capaz de»');
  });

  await check('OA18 stemmer (re-review M-A/M-B): planea = planeación = planear, costeo = costo; marco ≠ marca, medio ≠ media, cargo ≠ carga, informe ≠ información', () => {
    const st = (w) => A.lightStem(w);
    for (const [a, b] of [['planea', 'planeacion'], ['planear', 'planeacion'], ['costeo', 'costo']]) eq(st(a), st(b), `${a} = ${b}`);
    for (const [a, b] of [['marco', 'marca'], ['medio', 'media'], ['cargo', 'carga'], ['puesto', 'puesta'], ['libro', 'libra'], ['informe', 'informacion']]) assert(st(a) !== st(b), `${a} ≠ ${b}`);
    const one = (lo, chapters) => A.planDocumentlessLinks(A.academicContextFromProfile(null, profileOf(lo), null).context, chapters);
    const n1 = one({ know: ['Explica el marco normativo de la publicidad'] }, [ch('a', 'Gestión de marca y publicidad digital', 'Posicionar la marca en redes'), ch('b', 'Investigación de mercados', 'Diseñar una encuesta'), ch('c', 'Precios', 'Fijar precios')]);
    eq([n1.links, n1.ambiguous.map((x) => x.id)], [[], ['RA1']], 'marco normativo ≠ marca');
    const n7 = one({ do: ['Elabora un informe de gestión'] }, [ch('a', 'Sistemas de información', 'Gestionar la información de la empresa'), ch('b', 'Redacción técnica', 'Redactar textos técnicos'), ch('c', 'Indicadores', 'Calcular indicadores de gestión')]);
    assert(!n7.links.some((l) => l.chapterId === 'a'), 'informe ≠ «Sistemas de información»: ' + JSON.stringify(n7.links));
  });

  await check('OA19 recall (re-review I-B): un título corto que está entero en el resultado vincula; evidencia que no distingue entre dos resultados → revisión', () => {
    const one = (lo, chapters) => A.planDocumentlessLinks(A.academicContextFromProfile(null, profileOf(lo), null).context, chapters);
    const lg = one({ do: ['Analiza la cadena de suministro de una organización.', 'Planea la demanda con métodos cuantitativos sencillos.', 'Gestiona inventarios y almacenes con indicadores.'] },
      [ch('l1', 'Fundamentos de la cadena de suministro', null), ch('l2', 'Planeación de la demanda', null), ch('l3', 'Gestión de inventarios', null), ch('l4', 'Transporte y distribución', null)]);
    const L = linksOf(lg);
    eq([L.l1, L.l2, L.l3], [['RA1'], ['RA2'], ['RA3']], 'cadena / planeación / inventarios');
    eq(L.l4, undefined, 'transporte no encaja: revisión');
    const mo = one({ do: ['Identifica los elementos del costo: materiales, mano de obra y costos indirectos', 'Calcula el costo de los materiales y de la mano de obra con métodos de valoración'] },
      [ch('m1', 'Asignación de la mano de obra', null), ch('m2', 'Elementos del costo', null), ch('m3', 'Métodos de valoración de inventarios', null)]);
    assert(!(linksOf(mo).m1 || []).length, '«mano de obra» está en los dos resultados: el capítulo no decide entre ellos: ' + JSON.stringify(linksOf(mo)));
  });

  if (PURE_ONLY) console.log('\n(--pure-only: parte DB omitida)');
  else await dbChecks(doc);

  eq(netAttempts, [], 'red');
  console.log(`\n${passed} ok · ${failed} fallas · red fuera de loopback: ${netAttempts.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b16\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function cleanEnv() { return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' }; }

async function dbChecks(doc) {
  console.log('\nParte DB');
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException, Logger } = require('@nestjs/common');
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { PedagogyService } = loadDist('modules/pedagogy/pedagogy.service.js');
  const { CourseDesignService } = loadDist('modules/course-design/course-design.service.js');
  const { PrebriefService } = loadDist('modules/prebrief/prebrief.service.js');
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r63-ac-pg16-'));
  const DB = 'r63acdb';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = { flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS, unowned: process.env.ALLOW_UNOWNED_COURSES, rules: process.env.DYNAMIC_MANIFEST_RULES_VERSION, atr: process.env.DYNAMIC_ACTIVITY_TYPE_RULES };
  let started = false;
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`  Postgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', (c) => c.query(`create database ${DB}`));
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql',
        'supabase-migration-v21-blueprint-profiles.sql', 'supabase-migration-pedagogy-profiles.sql', 'supabase-migration-practice-chapters.sql',
        'supabase-migration-application-activities.sql', 'supabase-migration-guided-practice.sql', 'supabase-migration-academic-context.sql', 'supabase-migration-prebrief.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_ACTIVITY_TYPE_RULES = '2';
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [CourseModule, CourseChapter], synchronize: false });
    await ds.initialize();
    const coursesStub = {
      async findOne(id, ownerId) {
        const [row] = await ds.query(`select id, title, structure_version, structure_version_counter from public.courses where id = $1 and owner_id = $2`, [id, ownerId]);
        if (!row) throw new NotFoundException(`Course #${id} not found`);
        return { id: row.id, title: row.title, structureVersion: row.structure_version, structureVersionCounter: row.structure_version_counter };
      },
    };
    const profiles = new CourseProfilesService(ds, coursesStub);
    const blueprints = new CourseBlueprintsService(ds);
    const pedagogy = new PedagogyService(ds, coursesStub);
    const design = new CourseDesignService(ds, coursesStub, pedagogy);
    const prebrief = new PrebriefService(ds, coursesStub, design, blueprints, profiles);
    const structure = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const counter = async (cid) => Number((await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c);
    const versions = async (cid, kind) => (await ds.query(`select version from public.course_profiles where course_id = $1 and kind = $2 order by version`, [cid, kind])).map((x) => Number(x.version));
    const links = async (cid) => (await ds.query(`select ch.title, ch.outcome_ids from public.course_chapters ch join public.course_modules m on m.id = ch.module_id where ch.course_id = $1 order by m.position, ch.position`, [cid])).map((x) => [x.title, x.outcome_ids]);
    const newCourse = async (title, chapters = R1.chapters) => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, $2, 'dynamic', true, 'h5p') returning id`, [OWNER, title]);
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title, objective, exam_enabled) values ($1, 0, $2, $3, true) returning id`, [c.id, R1.module.title, R1.module.objective]);
      for (const [i, x] of chapters.entries()) {
        await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective, video_enabled, activity_enabled, application_minutes) values ($1, $2, $3, $4, $5, true, true, 30)`, [c.id, m.id, i, x.title, x.objective]);
      }
      return { id: c.id, moduleId: m.id };
    };
    // Perfil guardado «a la antigua» (antes de r63: sin contexto académico ni vínculos), directo en la tabla.
    const legacyProfile = async (cid, p) => {
      const n = CP.normalizeProfile('pedagogy', p);
      await ds.query(`insert into public.course_profiles (course_id, kind, version, data, sha256, created_by) values ($1, 'pedagogy', 1, $2::jsonb, $3, $4)`, [cid, JSON.stringify(n), CP.profileSha256(n), OWNER]);
    };
    const R1_LINKS = [[R1.chapters[0].title, ['RA1', 'CO1']], [R1.chapters[1].title, ['RA2', 'CO1']]];
    const OD = {};

    await check('OD1 caso R1 sin documento: contexto al guardar el perfil; «Usar este diseño» vincula solo; 2 de 2 · 1 de 1; evaluaciones alineadas', async () => {
      const c = await newCourse('[R1 · SINTÉTICO] Primeros auxilios básicos en el trabajo');
      const c0 = await counter(c.id);
      const res = await profiles.append(c.id, OWNER, 'pedagogy', R1_PROFILE, 0);
      eq([res.created, res.academicFromProfile.context.action, res.academicFromProfile.context.added], [true, 'create', ['RA1', 'RA2', 'CO1']], 'contexto creado');
      eq(await versions(c.id, 'pedagogy'), [1], 'el perfil pedagógico no cambia de versión (sin derivación de vuelta)');
      eq(await versions(c.id, 'academic'), [1], 'contexto académico v1');
      const ac = await profiles.getCurrent(c.id, OWNER, 'academic');
      eq(ac.profile.outcomes.map((o) => [o.id, o.text]), [['RA1', R1.RA1], ['RA2', R1.RA2]], 'RA');
      eq(ac.profile.competencies.map((x) => [x.id, x.text]), [['CO1', R1.CO1]], 'CO');
      eq(await counter(c.id), c0, 'guardar el perfil no sube el contador (la interfaz sigue con el suyo)');
      // «Usar este diseño» (FE 52-v2-design.js): la verificación muestra lo que Cursia vincula y el uso lo aplica con el contador vigente.
      const pre = await design.recommend(c.id, OWNER, {});
      const pv = pre.verification.checks.find((x) => x.id === 'outcome_links');
      assert(pv && pv.fix.kind === 'auto', 'vista previa «Cursia vinculará…»: ' + JSON.stringify(pre.verification.checks.filter((x) => x.area === 'outcomes').map((x) => x.title)));
      const fx = await design.fix(c.id, OWNER, 'link_outcomes', c0);
      eq([fx.linkedChapters, fx.structureVersionCounter], [2, c0 + 1], 'vinculó los dos capítulos (una subida del contador)');
      eq(await links(c.id), R1_LINKS, 'RA1 → Cap. 1, RA2 → Cap. 2, CO1 → ambos, sin intervención');
      const card = await design.recommend(c.id, OWNER, {});
      const ids = Object.fromEntries(card.verification.checks.map((x) => [x.id, x]));
      eq(ids.outcomes.title, '2 de 2 resultados de aprendizaje con evidencia · 1 de 1 competencias', 'cobertura');
      assert(!card.verification.checks.some((x) => x.id === 'outcome_links' || x.id === 'outcome_review' || (x.fix && x.fix.kind === 'auto')), 'nada pendiente: ' + JSON.stringify(card.verification.checks.filter((x) => x.fix && x.fix.kind === 'auto').map((x) => x.title)));
      const crit = card.verification.checks.filter((x) => x.severity === 'critical' && x.area === 'outcomes');
      eq(crit.map((x) => x.title), [], 'sin críticos de resultados');
      eq(card.outcomes, [{ id: 'RA1', text: R1.RA1 }, { id: 'RA2', text: R1.RA2 }], 'la tarjeta lista los resultados');
      eq(card.design.proposalSha256, pre.design.proposalSha256, 'misma huella del diseño antes y después de vincular (el uso no se corta)');
      // Evaluaciones alineadas: el examen del módulo y el final evidencian RA1 y RA2 (alineación del Coherence Engine).
      const dr = await pedagogy.dryRunCourse(c.id, OWNER, {});
      const al = dr.alignment;
      assert(al && al.available, 'alineación disponible');
      for (const id of ['RA1', 'RA2']) {
        const o = al.outcomes.find((x) => x.id === id);
        assert(o && o.evidence.some((e) => e.kind === 'assessment' && e.type === 'exam') && o.evidence.some((e) => e.kind === 'assessment' && e.type === 'final_exam'), `${id} evaluado en el examen del módulo y el final: ${JSON.stringify(o && o.evidence.map((e) => e.kind + ':' + e.type))}`);
        eq(o.chapterIds.length, 1, `${id} en un capítulo`);
      }
      assert(!al.findings.some((f) => f.severity === 'critical'), 'alineación sin críticos: ' + JSON.stringify(al.findings.filter((f) => f.severity === 'critical').map((f) => f.message)));
      OD.r1 = c.id;
    });

    await check('OD2 idempotente: re-guardar el mismo perfil no crea versiones ni sube el contador', async () => {
      const cid = OD.r1;
      const c0 = await counter(cid);
      const res = await profiles.append(cid, OWNER, 'pedagogy', R1_PROFILE, 1);
      eq([res.created, res.academicFromProfile], [false, undefined], 'sin cambios');
      eq([await versions(cid, 'pedagogy'), await versions(cid, 'academic'), await counter(cid)], [[1], [1], c0], 'mismas versiones y contador');
      eq(await links(cid), R1_LINKS, 'mismos vínculos');
    });

    await check('OD3 capítulos después del perfil: vista previa sin escribir y «Usar este diseño» vincula; curso anterior también', async () => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, 'Perfil primero', 'dynamic', true, 'h5p') returning id`, [OWNER]);
      await profiles.append(c.id, OWNER, 'pedagogy', R1_PROFILE, 0);
      eq(await versions(c.id, 'academic'), [1], 'contexto creado aunque no haya capítulos');
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title, exam_enabled) values ($1, 0, $2, true) returning id`, [c.id, R1.module.title]);
      for (const [i, x] of R1.chapters.entries()) await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective) values ($1, $2, $3, $4, $5)`, [c.id, m.id, i, x.title, x.objective]);
      const card = await design.recommend(c.id, OWNER, {});
      const pv = card.verification.checks.find((x) => x.id === 'outcome_links');
      assert(pv && pv.fix.kind === 'auto' && /RA1, CO1/.test(pv.detail) && /RA2, CO1/.test(pv.detail), 'vista previa: ' + JSON.stringify(pv));
      const fx = await design.fix(c.id, OWNER, 'link_outcomes', await counter(c.id));
      eq(fx.linkedChapters, 2, 'vinculó los dos');
      eq(await links(c.id), R1_LINKS, 'vínculos');
      // Curso anterior: perfil sin contexto (guardado antes de r63). La recomendación lo muestra SIN escribir nada…
      const old = await newCourse('Curso anterior');
      await legacyProfile(old.id, R1_PROFILE);
      const c0 = await counter(old.id);
      const card2 = await design.recommend(old.id, OWNER, {});
      eq([await versions(old.id, 'academic'), await counter(old.id)], [[], c0], 'recomendar no escribe');
      assert(card2.verification.checks.find((x) => x.id === 'outcomes').title !== 'Sin resultados de aprendizaje para verificar la coherencia', 'ya ve los resultados del perfil');
      assert(card2.verification.checks.some((x) => x.id === 'outcome_links' && x.fix.kind === 'auto'), '«Cursia vinculará…» al usar el diseño');
      // …y «Usar este diseño» (fix) guarda el contexto y vincula, con la MISMA huella del diseño.
      const fx2 = await design.fix(old.id, OWNER, 'link_outcomes', c0);
      eq([fx2.linkedChapters, fx2.contextVersion, await versions(old.id, 'academic')], [2, 1, [1]], 'contexto v1 + 2 vínculos');
      eq(await links(old.id), R1_LINKS, 'vínculos del curso anterior');
      const card3 = await design.recommend(old.id, OWNER, {});
      eq(card3.design.proposalSha256, card2.design.proposalSha256, 'misma huella del diseño (lo que se vio es lo que se usa)');
    });

    await check('OD4 curso con documento: el comportamiento de siempre (sin versión nueva, sin vínculos nuevos)', async () => {
      const c = await newCourse('Con documento', [{ title: 'Elementos del costo y su clasificación', objective: 'Clasificar los elementos del costo' }, { title: 'Costo de materiales y mano de obra', objective: 'Calcular el costo de materiales' }]);
      await profiles.append(c.id, OWNER, 'academic', doc);
      const before = { ac: await versions(c.id, 'academic'), links: await links(c.id), counter: await counter(c.id) };
      const extra = 'Explica la importancia de los costos en la toma de decisiones gerenciales';
      const pv = (await profiles.getCurrent(c.id, OWNER, 'pedagogy')).version; // el documento ya derivó el perfil (8.1)
      const res = await profiles.append(c.id, OWNER, 'pedagogy', profileOf({ know: [doc.outcomes[0].text, extra], do: [], competencies: [doc.competencies[0].text] }), pv);
      eq([res.academicFromProfile.skipped, res.academicFromProfile.context.ignored, res.academicFromProfile.linked], ['DOCUMENT_CONTEXT', [extra], []], 'el documento manda');
      eq({ ac: await versions(c.id, 'academic'), links: await links(c.id), counter: await counter(c.id) }, before, 'nada cambió');
      const ac = await profiles.getCurrent(c.id, OWNER, 'academic');
      eq(sha(ac.profile), sha(doc), 'el mismo contexto del documento');
      // «Usar este diseño» con documento: la vinculación de siempre (no la de sin documento).
      const card = await design.recommend(c.id, OWNER, {});
      assert(!card.verification.checks.some((x) => x.id === 'outcome_review'), 'sin «requiere revisión» (solo sin documento)');
    });

    await check('OD5 perfil y después documento: reemplaza; vínculos a ids del perfil que cambian de significado se quitan; sin duplicados', async () => {
      const c = await newCourse('Perfil y documento');
      await profiles.append(c.id, OWNER, 'pedagogy', R1_PROFILE, 0);
      await design.fix(c.id, OWNER, 'link_outcomes', await counter(c.id));
      eq(await links(c.id), R1_LINKS, 'vinculado desde el perfil');
      const res = await profiles.append(c.id, OWNER, 'academic', doc, 1);
      eq(await versions(c.id, 'academic'), [1, 2], 'el documento es la versión 2');
      // RA1/RA2/CO1 del documento son otros textos: los vínculos del perfil no pueden quedar apuntando a ellos.
      eq(await links(c.id), [[R1.chapters[0].title, null], [R1.chapters[1].title, null]], 'vínculos con otro significado quitados');
      assert(res.prunedOutcomeLinks && res.prunedOutcomeLinks.length === 2, 'informado: ' + JSON.stringify(res.prunedOutcomeLinks));
      const ac = (await profiles.getCurrent(c.id, OWNER, 'academic')).profile;
      eq(ac.outcomes.length, doc.outcomes.length, 'solo los resultados del documento (sin duplicar los del perfil)');
      const meta = (await ds.query(`select metadata -> 'academicFromProfile' r from public.courses where id = $1`, [c.id]))[0].r;
      eq(meta, null, 'desde ahí manda el documento (registro del puente borrado)');
      // Guardar el perfil otra vez no agrega nada al documento.
      const v = (await profiles.getCurrent(c.id, OWNER, 'pedagogy')).version;
      const again = await profiles.append(c.id, OWNER, 'pedagogy', { ...R1_PROFILE, targetHours: 12 }, v);
      eq([again.academicFromProfile.skipped, await versions(c.id, 'academic')], ['DOCUMENT_CONTEXT', [1, 2]], 'el documento sigue mandando');
    });

    // Deja un curso listo para preparar el Prebrief como lo haría la interfaz: pedido completo, «Usar este diseño»
    // (perfil + diseño aplicados, SIN «Vincular ahora»: los vínculos quedan solo en la vista previa) y datos confirmados.
    const R1_BRIEF = { nombre: '[R1 · SINTÉTICO] Primeros auxilios básicos en el trabajo', obj: 'Brindar la primera respuesta ante una emergencia en el lugar de trabajo mientras llega la ayuda profesional',
      sector: 'Seguridad y salud en el trabajo', pais: 'Colombia', contexto: 'Técnico / Tecnólogo — formación técnica', nivel: 'Básico — sin conocimientos previos', tono: 'cercano y claro', comp: R1.CO1 };
    const makeReady = async (cid) => {
      await ds.query(`update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{brief}', $2::jsonb, true) where id = $1`, [cid, JSON.stringify({ briefVersion: 1, fields: R1_BRIEF, updatedAt: '2026-10-21T00:00:00.000Z' })]);
      let last = null;
      for (let i = 0; i < 6; i++) {
        const st = await prebrief.state(cid, OWNER);
        if (st.draft.readiness.ready) return st;
        const bl = st.draft.readiness.blockers || [];
        last = bl.map((b) => `${b.code}: ${b.title}`);
        if (bl.some((b) => b.code === 'pending_changes' || b.code === 'design_not_saved')) {
          const card = await design.recommend(cid, OWNER, {});
          if (card.profileChanged) await profiles.append(cid, OWNER, 'pedagogy', card.profile, card.profileVersion);
          const c2 = await design.recommend(cid, OWNER, {});
          await structure.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: c2.design.proposalSha256 });
          continue;
        }
        const doubts = bl.filter((b) => b.code === 'doubtful_data' && b.ref);
        if (!doubts.length) break;
        for (const b of doubts) await prebrief.confirm(cid, OWNER, { id: OWNER, email: null }, b.ref);
      }
      throw new Error('el curso no quedó listo: ' + JSON.stringify(last));
    };

    await check('OD6 Prebrief: GET sin escribir; «Preparar» valida ANTES de escribir (M-C) y, listo, prepara DE VERDAD con la huella vista; Blueprint con contexto y vínculos (sha); después no cambia', async () => {
      const c = await newCourse('Prebrief anterior');
      await legacyProfile(c.id, R1_PROFILE);
      const st = await makeReady(c.id);
      const outs = st.draft.model.goals && st.draft.model.goals.outcomes;
      assert(Array.isArray(outs) && outs.length === 2 && outs.every((o) => o.chapters.length === 1), 'la vista previa ya no dice «Sin capítulo asignado»: ' + JSON.stringify(outs));
      const before = { links: (await links(c.id)).map((x) => x[1]), counter: await counter(c.id), ac: await versions(c.id, 'academic') };
      assert(before.links.every((x) => x === null), 'los vínculos todavía son solo vista previa (el GET no escribe): ' + JSON.stringify(before.links));
      const st2 = await prebrief.state(c.id, OWNER);
      eq([st2.draft.modelSha256, await counter(c.id), await versions(c.id, 'academic')], [st.draft.modelSha256, before.counter, before.ac], 'dos GET: misma huella y nada escrito');
      // M-C: con una huella vieja, «Preparar» falla SIN escribir nada (ni contexto, ni vínculos, ni contador).
      const bad = await prebrief.prepare(c.id, OWNER, { id: OWNER, email: null }, 'f'.repeat(64)).then(() => null, (e) => e);
      assert(bad && /PREBRIEF_CHANGED/.test(String(bad.message || (bad.getResponse && JSON.stringify(bad.getResponse())))), 'huella vieja → PREBRIEF_CHANGED: ' + (bad && bad.message));
      eq({ links: (await links(c.id)).map((x) => x[1]), counter: await counter(c.id), ac: await versions(c.id, 'academic') }, before, 'el error no escribió nada');
      // «Preparar» de verdad, con la huella que se vio en la vista previa.
      const pr = await prebrief.prepare(c.id, OWNER, { id: OWNER, email: null }, st.draft.modelSha256);
      assert(pr && pr.created === true && pr.version && pr.version.status === 'ready', 'preparado: ' + JSON.stringify(pr && { created: pr.created, status: pr.version && pr.version.status }));
      eq(pr.version.modelSha256, st.draft.modelSha256, 'la versión preparada tiene la huella de la vista previa');
      const contentLinks = (await links(c.id)).filter((x) => R1.chapters.some((r) => r.title === x[0]));
      eq(contentLinks, R1_LINKS, '«Preparar» guardó los vínculos (el capítulo de práctica que agregó el diseño integra los del módulo)');
      assert((await versions(c.id, 'academic')).length >= 1, 'y el contexto');
      const locked = await blueprints.lock(c.id, OWNER, await counter(c.id));
      eq(locked.created, false, 'el Blueprint ya lo congeló «Preparar»');
      const bp = locked.blueprint;
      eq(String(bp.id), String(pr.version.blueprintId ?? bp.id), 'el Blueprint de la versión');
      const snap = bp.snapshot;
      assert(snap.course.academicContext && snap.course.academicContext.outcomes.length === 2 && snap.course.academicContext.competencies.length === 1, 'el Blueprint congela el contexto');
      eq(snap.modules[0].chapters.filter((x) => x.kind !== 'practice').map((x) => x.outcomeIds), [['RA1', 'CO1'], ['RA2', 'CO1']], 'y los vínculos');
      const SNAP = loadDist('modules/course-blueprints/blueprint-snapshot.js');
      eq(SNAP.snapshotSha256V2(snap), String(bp.sha256), 'sha del Blueprint verificado');
      const row0 = (await ds.query(`select snapshot_sha256 sha, snapshot_json::text s from public.course_blueprints where id = $1`, [bp.id]))[0];
      eq(row0.sha.trim(), String(bp.sha256), 'el sha guardado es el del snapshot');
      // Nada lo cambia después: re-guardar el perfil, GET /prebrief, recomendar.
      const acBefore = await versions(c.id, 'academic');
      await profiles.append(c.id, OWNER, 'pedagogy', (await profiles.getCurrent(c.id, OWNER, 'pedagogy')).profile, (await profiles.getCurrent(c.id, OWNER, 'pedagogy')).version);
      await prebrief.state(c.id, OWNER);
      await design.recommend(c.id, OWNER, {});
      const again = await blueprints.lock(c.id, OWNER, await counter(c.id));
      eq([again.created, String(again.blueprint.id)], [false, String(bp.id)], 'el mismo Blueprint (idempotente por huella)');
      const row1 = (await ds.query(`select snapshot_sha256 sha, snapshot_json::text s from public.course_blueprints where id = $1`, [bp.id]))[0];
      eq(row1, row0, 'Blueprint congelado intacto');
      eq(await versions(c.id, 'academic'), acBefore, 'sin versiones nuevas');
    });

    await check('OD7 regresión: Blueprint congelado antes no cambia; propuesta lista/aprobada o producción en curso → no se toca nada', async () => {
      const c = await newCourse('Congelado antes');
      await legacyProfile(c.id, R1_PROFILE);
      const locked = await blueprints.lock(c.id, OWNER, await counter(c.id));
      const row0 = (await ds.query(`select id, snapshot_sha256 sha, snapshot_json::text s from public.course_blueprints where id = $1`, [locked.blueprint.id]))[0];
      const snap0 = JSON.parse(row0.s);
      eq(snap0.course.academicContext || null, null, 'el Blueprint anterior no tenía contexto');
      // Una propuesta preparada con ese Blueprint: GET /prebrief no completa nada (no la invalida sola).
      await ds.query(`insert into public.course_prebrief_versions (course_id, version, status, model_version, model_json, model_sha256, document_json, document_sha256, blueprint_id, blueprint_number, blueprint_sha256, prepared_by)
        values ($1, 1, 'approved', 1, '{}'::jsonb, $2, '{}'::jsonb, $2, $3, $4, $5, $6)`, [c.id, 'a'.repeat(64), locked.blueprint.id, locked.blueprint.blueprintNumber, row0.sha.trim(), OWNER]);
      const ce0 = await counter(c.id);
      const card = await design.recommend(c.id, OWNER, {});
      eq(card.verification.checks.find((x) => x.id === 'outcomes').title, 'Sin resultados de aprendizaje para verificar la coherencia', 'con una propuesta aprobada la vista previa no cambia (no se invalida sola)');
      const same = await profiles.append(c.id, OWNER, 'pedagogy', R1_PROFILE, 1);
      eq([same.created, same.academicFromProfile, await versions(c.id, 'academic'), await counter(c.id)], [false, undefined, [], ce0], 're-guardar el mismo perfil con la propuesta aprobada no toca nada');
      // Review M3: un perfil NUEVO (cambiado) sobre la propuesta aprobada tampoco escribe el contexto (se guarda al preparar de nuevo).
      const changed = await profiles.append(c.id, OWNER, 'pedagogy', { ...R1_PROFILE, targetHours: 9 }, 1);
      eq([changed.created, changed.academicFromProfile.skipped, await versions(c.id, 'academic')], [true, 'PREBRIEF_FROZEN', []], 'perfil nuevo con propuesta aprobada: sin contexto');
      const row1 = (await ds.query(`select id, snapshot_sha256 sha, snapshot_json::text s from public.course_blueprints where id = $1`, [locked.blueprint.id]))[0];
      eq(row1, row0, 'Blueprint congelado intacto');
      // Producción en curso: ni el guardado de un perfil nuevo toca el contexto.
      const p = await newCourse('En producción');
      await ds.query(`alter table public.production_jobs drop constraint if exists production_jobs_execution_mode_check`); // base desechable sin la migración de runs
      await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, worker_status, status) values ($1, $2, 'dynamic_generation', 'running', 'running')`, [OWNER, p.id]);
      const res = await profiles.append(p.id, OWNER, 'pedagogy', R1_PROFILE, 0);
      eq([res.academicFromProfile.skipped, await versions(p.id, 'academic')], ['PRODUCTION_ACTIVE', []], 'producción en curso: nada');
      // Explícito («Vincular ahora») sobre la propuesta aprobada: sí (es el docente quien lo pide).
      const fx = await design.fix(c.id, OWNER, 'link_outcomes', ce0);
      eq([fx.linkedChapters, await versions(c.id, 'academic')], [2, [1]], 'el pedido explícito sí vincula');
      const row2 = (await ds.query(`select id, snapshot_sha256 sha, snapshot_json::text s from public.course_blueprints where id = $1`, [locked.blueprint.id]))[0];
      eq(row2, row0, 'y el Blueprint congelado sigue intacto');
    });
    await check('OD8 resultado del perfil sin capítulo claro: «Requiere revisión» como advertencia; no bloquea el Prebrief', async () => {
      const RA3 = 'Reconoce la normativa de seguridad social vigente';
      const c = await newCourse('Ambiguo');
      const p = profileOf({ know: [R1.RA1, RA3], do: [R1.RA2], competencies: [R1.CO1] });
      await profiles.append(c.id, OWNER, 'pedagogy', p, 0);
      await design.fix(c.id, OWNER, 'link_outcomes', await counter(c.id));
      // Saber va primero: RA1 = cadena de emergencia, RA2 = normativa (ambiguo), RA3 = heridas y quemaduras.
      eq(await links(c.id), [[R1.chapters[0].title, ['RA1', 'CO1']], [R1.chapters[1].title, ['RA3', 'CO1']]], 'RA1/RA3/CO1 vinculados; el ambiguo (RA2) no se fuerza');
      const card = await design.recommend(c.id, OWNER, {});
      const rv = card.verification.checks.find((x) => x.id === 'outcome_review');
      assert(rv && rv.severity === 'warning' && /RA2/.test(rv.detail), '«Requiere revisión»: ' + JSON.stringify(rv));
      const a1 = card.verification.checks.filter((x) => x.area === 'outcomes' && x.severity === 'critical' && !x.summary);
      eq(a1.map((x) => x.title), [], 'ningún crítico de resultados por el ambiguo');
      const st = await prebrief.state(c.id, OWNER);
      const blk = (st.draft.readiness.blockers || []).filter((b) => b.code === 'critical' && /^alignment:|^outcomes/.test(String(b.ref)));
      eq(blk, [], 'el Prebrief no queda bloqueado por el resultado ambiguo');
    });
    await check('OD9 quitar del perfil un resultado vinculado: el guardado no sube el contador; «Usar este diseño» con el contador de la interfaz no da 409 y devuelve el vigente (review I4)', async () => {
      const c = await newCourse('Quitar resultado');
      await profiles.append(c.id, OWNER, 'pedagogy', R1_PROFILE, 0);
      const fx0 = await design.fix(c.id, OWNER, 'link_outcomes', await counter(c.id));
      eq(await links(c.id), R1_LINKS, 'vinculado');
      const ui = fx0.structureVersionCounter; // DYN.structureVersionCounter de la interfaz
      const res = await profiles.append(c.id, OWNER, 'pedagogy', profileOf({ do: [R1.RA2], competencies: [R1.CO1] }), 1);
      eq([res.created, await counter(c.id), await versions(c.id, 'academic')], [true, ui, [1]], 'guardar el perfil no poda ni sube el contador');
      const card = await design.recommend(c.id, OWNER, {});
      eq(card.outcomes.map((o) => o.id), ['RA2'], 'la vista previa ya no cuenta RA1');
      const fx = await design.fix(c.id, OWNER, 'link_outcomes', ui);
      eq(fx.structureVersionCounter, await counter(c.id), 'devuelve el contador vigente (la poda lo subió)');
      eq(await versions(c.id, 'academic'), [1, 2], 'RA1 quitado del contexto al usar el diseño');
      eq(await links(c.id), [[R1.chapters[0].title, ['CO1']], [R1.chapters[1].title, ['RA2', 'CO1']]], 'vínculo a RA1 podado; los demás intactos');
    });

    await check('OD10 «Crear desde cero» (contexto propuesto sin unidades): vista previa y vínculos sin documento; ambiguo como advertencia (review M6)', async () => {
      const { AcademicContextService } = loadDist('modules/academic-context/academic-context.service.js');
      const acx = new AcademicContextService(ds, coursesStub, null, null, profiles);
      const c = await newCourse('Crear desde cero');
      await acx.saveProposal(c.id, OWNER, { expectedVersion: 0, outcomes: [R1.RA1, R1.RA2, 'Reconoce la normativa de seguridad social vigente'], competencies: [R1.CO1] });
      const card = await design.recommend(c.id, OWNER, {});
      const pv = card.verification.checks.find((x) => x.id === 'outcome_links');
      assert(pv && pv.fix.kind === 'auto', 'vista previa: ' + JSON.stringify(card.verification.checks.filter((x) => x.area === 'outcomes').map((x) => [x.id, x.severity, x.title])));
      const rv = card.verification.checks.find((x) => x.id === 'outcome_review');
      assert(rv && /RA3/.test(rv.detail), 'RA3 requiere revisión');
      eq(card.verification.checks.filter((x) => x.area === 'outcomes' && x.severity === 'critical' && !x.summary).map((x) => x.title), [], 'sin críticos de resultados');
      await design.fix(c.id, OWNER, 'link_outcomes', await counter(c.id));
      eq(await links(c.id), R1_LINKS, 'vínculos de la propuesta');
    });
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    for (const [k, v] of [['DYNAMIC_COURSE_STRUCTURE', saved.flag], ['DYNAMIC_V2_ALLOWED_OWNERS', saved.allow], ['ALLOW_UNOWNED_COURSES', saved.unowned], ['DYNAMIC_MANIFEST_RULES_VERSION', saved.rules], ['DYNAMIC_ACTIVITY_TYPE_RULES', saved.atr]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
}
