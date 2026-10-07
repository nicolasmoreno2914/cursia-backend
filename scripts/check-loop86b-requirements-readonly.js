#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.6B · Requisitos del documento en MODO LECTURA (detectar → mostrar → explicar). Contra dist/. USD 0.
// Todos los documentos de esta prueba son SINTÉTICOS (escritos aquí); ningún documento real entra al repositorio.
//
// Parte pura:
//   RB1 varias lecturas (una por documento) → ids únicos por documento; grupos y conflictos remapeados
//   RB2 lo que se guarda: sin la lista de cifras ignoradas, con tope de requisitos; huella de documentos estable
//   RB3 vista S/M/L: sin elegir, NINGÚN requisito activo (Cursia nunca elige); al elegir M solo aplican los de M; una
//       elección vieja (otros documentos) o desconocida no aplica nada
//   RB4 comparación con el diseño: M vs 3×4 / 42 h → todo ✓; vs 4×5 → se aparta (lo decidió Cursia); horas del docente
//       («Ajustar») → «Te estás apartando» (teacher); estructura editada por el docente → teacher
//   RB5 escenario completo (4×5, 2 videos/cap., 1 AA/mód., 3 parciales + 1 final, 64 h): 2 videos por capítulo → «no se
//       puede verificar» (Cursia hace uno); parciales = evaluaciones de módulo; final aparte; horas con D6 (±5 %, mín. 1 h)
//   RB6 unidades / por resultado / asignatura → «no se puede verificar»; condicionados no aplican sin datos
//   RB7 DOCX limpio en el navegador (función REAL de 50-academic-context-panel.js): sin imágenes ni fuentes, la
//       lectura del extractor es IDÉNTICA y el archivo pesa una fracción
//   RB12 (review I2) si el lector de requisitos falla, el documento se lee igual y se avisa en una nota
//   RB8 límites: 25 MB por documento; PDF de más de 600 páginas → DOCUMENT_TOO_MANY_PAGES antes de leer el texto; el
//       cuerpo de 36 MB solo en /academic-context/extract(-advanced) (el resto de la API sigue en 10 MB)
// Parte DB (Postgres 16 desechable; --pure-only la salta y lo dice):
//   RB9  /extract guarda los requisitos atados a la huella de los documentos; la vista vale cuando el contexto
//        guardado es de ESOS documentos (antes: none; contexto de otro documento: stale)
//   RB10 elegir alternativa: grupo u opción desconocidos → 400; ajeno → 404; quitar la elección; nunca automática
//   RB11 «Cursia recomienda» trae los requisitos con su comparación; elegir S/M/L NO escribe nada en el curso (ni
//        estructura, ni perfil, ni contador). Desde 8.6C la alternativa elegida sí restringe el diseño RECOMENDADO (una
//        propuesta: solo se aplica con «Usar este diseño»)
//   RB13 (review I1/M8) un PATCH del curso con metadata no borra ni falsifica los requisitos ni la elección; el listado
//        de cursos no arrastra las lecturas guardadas
//
// Uso: node scripts/check-loop86b-requirements-readonly.js [--pure-only] [path/to/dist]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
function loadDist(rel) {
  try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${err.message}`); process.exit(1); }
}
const RX = loadDist('modules/academic-context/requirements/requirements-extractor.js');
const DR = loadDist('modules/academic-context/requirements/document-requirements.js');
const TS = loadDist('modules/academic-context/extract/text-sources.js');
const A = loadDist('modules/academic-context/index.js');
const F = require('./lib/academic-fixtures.js');
const JSZip = require('jszip');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
async function rejectsRe(p, re, m, status) {
  try { await p; } catch (err) {
    const body = err && err.getResponse ? err.getResponse() : null;
    const text = [err && err.message, body && (typeof body === 'string' ? body : body.message || body.code)].filter(Boolean).join(' | ');
    assert(re.test(text), `${m}: error inesperado «${text}»`);
    if (status) eq(err.getStatus ? err.getStatus() : null, status, `${m}: status`);
    return;
  }
  throw new Error(`${m}: no falló`);
}

const read = (text) => TS.readText(Buffer.from(text, 'utf8'), 'text/plain');
const extract = (text, docId = 'D1') => RX.extractRequirements(read(text).lines, docId);

// Documentos SINTÉTICOS.
const SML_TABLE = 'Tamaños de curso\nTAMAÑO HORAS ESTRUCTURA\nS\n1 h/sem\n20–22 h 3 módulos\n× 3 capítulos\nM\n2 h/sem\n40–44 h 3 módulos\n× 4 capítulos\nL\n3 h/sem\n60–66 h 4 módulos\n× 5 capítulos\nLa institución elegirá un tamaño por asignatura.';
const FULL = 'El curso deberá tener 4 módulos con 5 capítulos por módulo. Cada capítulo tendrá 2 videos. Cada módulo tendrá una Actividad de Aplicación. Se realizarán 3 evaluaciones parciales y 1 evaluación final. La intensidad horaria total será de 64 horas.';

function design({ shape, video = 'content', aa = 'first', exams = true, finalExam = true, target = 42, hoursSource = 'proposed', teacher = false, practiceLast = false, avTeacher = false, appTeacher = false }) {
  const modules = shape.map((n) => ({
    examEnabled: exams,
    chapters: Array.from({ length: n }, (_, i) => ({
      kind: practiceLast && i === n - 1 ? 'practice' : 'content', proposed: false,
      videoEnabled: video === 'all' || (video === 'content' && !(practiceLast && i === n - 1)) || (video === 'first' && i === 0),
      activityEnabled: true, applicationMinutes: aa === 'first' && i === 0 ? 60 : aa === 'all' ? 45 : null, hours: 3,
    })),
  }));
  return { modules, evaluations: (exams ? shape.length : 0) + (finalExam ? 1 : 0), targetHours: target, hoursSource, structureByTeacher: teacher, audiovisualByTeacher: avTeacher, applicationByTeacher: appTeacher };
}
const byKind = (x, kind, et) => x.requirements.filter((r) => r.kind === kind && (!et || r.evaluationType === et));
const checkOf = (checks, r) => checks.find((c) => c.requirementId === r.id);

(async () => {
  console.log('Parte pura');

  await check('RB1 varias lecturas → ids únicos por documento; grupos y conflictos remapeados', async () => {
    const a = extract(SML_TABLE, 'D1');
    const b = extract(FULL, 'D2');
    const m = DR.mergeRequirementExtractions([{ documentId: 'D1', x: a }, { documentId: 'D2', x: b }]);
    eq(m.requirements.length, a.requirements.length + b.requirements.length, 'todos los requisitos');
    eq(new Set(m.requirements.map((r) => r.id)).size, m.requirements.length, 'ids únicos');
    assert(m.requirements.every((r) => /^D[12]-RQ\d+$/.test(r.id)), 'prefijo por documento');
    const ids = new Set(m.requirements.map((r) => r.id));
    for (const g of m.groups) {
      for (const id of [...(g.requirementIds || []), ...(g.options || []).flatMap((o) => o.requirementIds)]) assert(ids.has(id), `grupo ${g.id} apunta a ${id}`);
    }
    for (const r of m.requirements) if (r.groupId) assert(m.groups.some((g) => g.id === r.groupId), `${r.id} → grupo ${r.groupId}`);
    eq(m.requirements.filter((r) => r.source.documentId === 'D2').length, b.requirements.length, 'el documento de origen se conserva');
    eq(DR.mergeRequirementExtractions([{ documentId: 'D1', x: a }]), a, 'un documento: sin cambios');
  });

  await check('RB2 lo que se guarda: sin cifras ignoradas, con tope, huella estable', async () => {
    const x = extract(SML_TABLE + '\nPor ejemplo, un curso de 5 módulos.');
    assert(x.ignored.length > 0, 'quedan cifras ignoradas (ejemplo)');
    const docs = [{ id: 'D1', name: 'a.txt', sha256: 'aa' }, { id: 'D2', name: 'b.txt', sha256: 'bb' }];
    const e = DR.storedEntry(docs, x, '2026-10-07T00:00:00.000Z');
    eq(e.extraction.ignored, undefined, 'sin la lista');
    eq(e.extraction.ignoredCount, x.ignored.length, 'con el conteo');
    eq(e.key, DR.documentsKey(docs), 'huella');
    assert(DR.documentsKey(docs) !== DR.documentsKey([...docs].reverse()), 'el orden de los documentos cuenta');
    const many = { ...x, requirements: Array.from({ length: 250 }, (_, i) => ({ ...x.requirements[0], id: `RQ${i + 1}`, groupId: undefined })), groups: [] };
    eq(DR.storedEntry(docs, many).extraction.requirements.length, 200, 'tope de 200');
  });

  const smlX = extract(SML_TABLE);
  const docs1 = [{ id: 'D1', name: 'tamaños.txt', sha256: 'abc' }];
  const entry1 = DR.storedEntry(docs1, smlX);
  const gid = smlX.groups.find((g) => g.relation === 'oneOf').id;

  await check('RB3 vista S/M/L: sin elegir nada aplica; M → solo M; elección vieja o desconocida → nada', async () => {
    const v0 = DR.buildRequirementsView([entry1], null, docs1);
    eq(v0.state, 'current', 'estado');
    eq(v0.alternatives.length, 1, 'un grupo de alternativas');
    eq(v0.alternatives[0].label, 'Tamaño', 'S/M/L es «Tamaño»');
    eq(v0.alternatives[0].options.map((o) => o.id), ['S', 'M', 'L'], 'opciones en orden');
    eq(v0.alternatives[0].selected, null, 'Cursia no elige');
    eq(v0.items.filter((i) => i.applies).length, 0, 'ningún requisito activo sin elegir');
    const vM = DR.buildRequirementsView([entry1], { key: entry1.key, options: { [gid]: 'M' } }, docs1);
    eq(vM.alternatives[0].selected, 'M', 'M elegida');
    const act = vM.items.filter((i) => i.applies);
    assert(act.length > 0 && act.every((i) => i.optionId === 'M'), 'solo los de M');
    eq(act.find((i) => i.kind === 'modules').value, 3, 'M: 3 módulos');
    eq(act.find((i) => i.kind === 'chapters').value, 4, 'M: 4 capítulos por módulo');
    const h = act.find((i) => i.kind === 'target_hours');
    eq([h.mode, h.value, h.valueMax], ['range', 40, 44], 'M: 40–44 h');
    eq(RX.structureTotal(act.find((i) => i.kind === 'structure')), 12, 'M: 3 × 4 = 12');
    eq(act.find((i) => i.kind === 'modules').documentName, 'tamaños.txt', 'origen: nombre del documento');
    // Las alternativas nunca se suman.
    eq(vM.items.filter((i) => i.kind === 'target_hours' && i.applies).length, 1, 'una sola meta de horas activa');
    eq(DR.buildRequirementsView([entry1], { key: 'otra', options: { [gid]: 'M' } }, docs1).items.filter((i) => i.applies).length, 0, 'elección de otros documentos');
    eq(DR.buildRequirementsView([entry1], { key: entry1.key, options: { [gid]: 'XL' } }, docs1).items.filter((i) => i.applies).length, 0, 'opción desconocida');
    eq(DR.buildRequirementsView([entry1], null, [{ sha256: 'zzz' }]).state, 'stale', 'contexto de otro documento');
    eq(DR.buildRequirementsView([entry1], null, []).state, 'none', 'contexto sin documentos');
  });

  await check('RB4 M frente al diseño: ✓; se aparta (Cursia); horas del docente → teacher; estructura del docente → teacher', async () => {
    const vM = DR.buildRequirementsView([entry1], { key: entry1.key, options: { [gid]: 'M' } }, docs1);
    const app = vM.items.filter((i) => i.applies);
    let ch = DR.compareRequirements(app, design({ shape: [4, 4, 4], target: 42 }));
    eq(ch.map((c) => c.status), app.map(() => 'met'), '3 × 4 y 42 h cumplen todo');
    ch = DR.compareRequirements(app, design({ shape: [5, 5, 5, 5], target: 64 }));
    const mods = checkOf(ch, app.find((i) => i.kind === 'modules'));
    eq([mods.status, mods.actual.value, mods.chosenBy], ['unmet', 4, 'cursia'], 'módulos: se aparta (Cursia)');
    eq(checkOf(ch, app.find((i) => i.kind === 'chapters')).actual.each, [5, 5, 5, 5], 'capítulos por módulo del diseño');
    eq(checkOf(ch, app.find((i) => i.kind === 'structure')).actual.shape, [5, 5, 5, 5], 'forma del diseño');
    const hrs = checkOf(ch, app.find((i) => i.kind === 'target_hours'));
    eq([hrs.status, hrs.chosenBy], ['unmet', 'cursia'], 'horas propuestas por Cursia');
    ch = DR.compareRequirements(app, design({ shape: [4, 4, 4], target: 48, hoursSource: 'adjusted' }));
    eq([checkOf(ch, app.find((i) => i.kind === 'target_hours')).status, checkOf(ch, app.find((i) => i.kind === 'target_hours')).chosenBy], ['unmet', 'teacher'], '48 h del docente');
    ch = DR.compareRequirements(app, design({ shape: [4, 4, 4, 4], target: 42, teacher: true }));
    eq(checkOf(ch, app.find((i) => i.kind === 'modules')).chosenBy, 'teacher', 'estructura del docente');
    // Un capítulo propuesto por Cursia (práctica) en el diseño: la diferencia no es del docente.
    const d = design({ shape: [4, 4, 5], target: 42, teacher: true });
    d.modules[2].chapters[4].proposed = true;
    eq(checkOf(DR.compareRequirements(app, d), app.find((i) => i.kind === 'chapters')).chosenBy, 'cursia', 'capítulo propuesto');
  });

  await check('RB5 escenario completo: videos 2/cap. no verificable; parciales = exámenes de módulo; final aparte; D6', async () => {
    const x = extract(FULL);
    const app = RX.requirementsFor(x, {});
    eq(app.length, 8, '8 requisitos activos');
    const d = design({ shape: [5, 5, 5, 5], target: 64, aa: 'first', exams: true, finalExam: true });
    const ch = DR.compareRequirements(app, d);
    const st = (k, et) => checkOf(ch, app.find((r) => r.kind === k && (!et || r.evaluationType === et)));
    eq(st('modules').status, 'met', 'módulos');
    eq(st('chapters').status, 'met', 'capítulos por módulo');
    eq(st('structure').status, 'met', 'estructura');
    eq([st('videos').status, /un video por capítulo/.test(st('videos').note)], ['not_verifiable', true], 'videos 2 por capítulo');
    eq(st('application_activities').status, 'met', '1 AA por módulo');
    eq([st('evaluations', 'partial').status, st('evaluations', 'partial').actual.value], ['unmet', 4], '4 exámenes de módulo ≠ 3 parciales');
    eq(st('evaluations', 'final').status, 'met', 'final');
    eq(st('target_hours').status, 'met', '64 h');
    const three = design({ shape: [5, 5, 5], target: 64, exams: true, finalExam: true });
    // 3 módulos con examen → 3 parciales ✓ (pero 3 módulos ≠ 4).
    eq(checkOf(DR.compareRequirements(app, three), app.find((r) => r.evaluationType === 'partial')).status, 'met', '3 parciales');
    const hr = app.find((r) => r.kind === 'target_hours');
    eq(DR.compareRequirements([hr], design({ shape: [1], target: 60.8 }))[0].status, 'met', '60,8 h dentro de ±5 %');
    eq(DR.compareRequirements([hr], design({ shape: [1], target: 60.5 }))[0].status, 'unmet', '60,5 h fuera');
    eq(DR.hoursTolerance(10), 1, 'mínimo ±1 h');
    const noAA = design({ shape: [5, 5, 5, 5], target: 64, aa: 'none' });
    eq(checkOf(DR.compareRequirements(app, noAA), app.find((r) => r.kind === 'application_activities')).actual.each, [0, 0, 0, 0], 'AA por módulo del diseño');
    eq(checkOf(DR.compareRequirements(app, design({ shape: [5, 5, 5, 5], target: 64, appTeacher: true, aa: 'none' })), app.find((r) => r.kind === 'application_activities')).chosenBy, 'teacher', 'modo de AA del docente');
    const oneVideo = RX.requirementsFor(extract('Cada capítulo tendrá un video.'), {});
    eq(DR.compareRequirements(oneVideo, design({ shape: [2, 2], video: 'content' }))[0].status, 'met', '1 video por capítulo: todos los de contenido');
    eq(DR.compareRequirements(oneVideo, design({ shape: [2, 2], video: 'first' }))[0].status, 'unmet', 'a la mitad le falta el video');
  });

  await check('RB6 unidades / por resultado / asignatura → no verificable; condicionados no aplican sin datos', async () => {
    const units = RX.requirementsFor(extract('El curso tendrá 3 unidades.'), {});
    eq(DR.compareRequirements(units, design({ shape: [3] }))[0].status, 'not_verifiable', 'unidades');
    const outcome = RX.requirementsFor(extract('Se realizará 1 evaluación por resultado de aprendizaje.'), {});
    eq(DR.compareRequirements(outcome, design({ shape: [3] }))[0].status, 'not_verifiable', 'por resultado');
    const subj = extract('Horas por asignatura:\nMatemáticas — 64 horas\nEstadística — 96 horas');
    eq(RX.requirementsFor(subj, {}).length, 0, 'sin asignatura elegida no aplica nada');
    const cond = extract('Si el curso tiene 3 créditos, deberá tener 4 módulos.');
    eq(RX.requirementsFor(cond, {}).length, 0, 'condicionado sin datos');
  });

  await check('RB7 DOCX limpio con la función REAL del frontend: misma lectura, mucho más liviano', async () => {
    const fe = process.env.CURSIA_FRONTEND_REPO;
    if (!fe || !fs.existsSync(path.join(fe, 'src/js/50-academic-context-panel.js'))) throw new Error('CURSIA_FRONTEND_REPO no apunta al frontend');
    const src = fs.readFileSync(path.join(fe, 'src/js/50-academic-context-panel.js'), 'utf8');
    const ctx = { window: {}, console };
    vm.createContext(ctx);
    // Solo las piezas puras (sin el DOM): la expresión y la función de limpieza.
    const reLine = src.match(/var ACX_DOCX_STRIP_RE = [^\n]+/)[0];
    const fn = src.slice(src.indexOf('function acxStripDocxData'), src.indexOf('function acxReadRaw'));
    vm.runInContext(reLine + '\n' + fn + '\nthis.strip = acxStripDocxData;', ctx);
    const base = await F.fixture('consistent', 'docx');
    const zip = await JSZip.loadAsync(base);
    const junk = Buffer.alloc(3 * 1024 * 1024, 7);
    zip.file('word/media/image1.png', junk);
    zip.file('word/fonts/font1.odttf', junk);
    zip.file('word/embeddings/oleObject1.bin', junk);
    zip.file('docProps/thumbnail.jpeg', junk);
    const heavy = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    const b64 = await ctx.strip(new Uint8Array(heavy), JSZip);
    const light = Buffer.from(b64, 'base64');
    assert(heavy.length > 12 * 1024 * 1024 && light.length < 100 * 1024, `pesa ${heavy.length} → ${light.length}`);
    const names = Object.keys((await JSZip.loadAsync(light)).files);
    assert(!names.some((n) => /^word\/(media|fonts|embeddings)\/|^docProps\/thumbnail/.test(n)), 'sin imágenes, fuentes, objetos ni miniatura');
    assert(names.includes('word/document.xml'), 'el texto se queda');
    eq((await TS.readDocx(light)).lines, (await TS.readDocx(heavy)).lines, 'lectura idéntica');
    const ex1 = await A.extractAcademicContext([{ name: 'a.docx', data: heavy }]);
    const ex2 = await A.extractAcademicContext([{ name: 'a.docx', data: light }]);
    eq(ex2.context.outcomes, ex1.context.outcomes, 'mismo contexto (resultados)');
    eq(ex2.requirements.requirements.length, ex1.requirements.requirements.length, 'mismos requisitos');
  });

  await check('RB12 si el lector de requisitos falla, el documento se lee igual (contexto completo) y se avisa', async () => {
    const orig = RX.extractRequirements;
    RX.extractRequirements = () => { throw new Error('falla forzada'); };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const r = await A.extractAcademicContext([{ name: 'micro.txt', data: Buffer.from(F.toText('consistent').toString('utf8') + '\n' + SML_TABLE, 'utf8') }]);
      assert(r.context.outcomes.length > 0, 'el contexto se leyó');
      eq(r.requirements.requirements.length, 0, 'sin requisitos');
      assert(r.notes.some((n) => n.code === 'REQUIREMENTS_NOT_READ' && /no pudimos leer sus requisitos/.test(n.message)), 'nota visible');
    } finally { RX.extractRequirements = orig; console.warn = warn; }
    const ok = await A.extractAcademicContext([{ name: 'micro.txt', data: Buffer.from(SML_TABLE, 'utf8') }]);
    assert(ok.requirements.requirements.length > 0 && !ok.notes.some((n) => n.code === 'REQUIREMENTS_NOT_READ'), 'sin la falla, se leen');
  });

  await check('RB8 límites: 25 MB por documento; > 600 páginas → DOCUMENT_TOO_MANY_PAGES; 36 MB solo en /extract', async () => {
    eq(TS.MAX_DOCUMENT_BYTES, 25 * 1024 * 1024, '25 MB');
    eq(TS.MAX_PDF_PAGES, 600, '600 páginas');
    const txt = Buffer.from('El curso tendrá 3 módulos.\n'.repeat(Math.ceil((8 * 1024 * 1024) / 27)), 'utf8');
    assert((await TS.readDocument(txt, 'grande.txt')).lines.length > 0, '8 MB (antes rechazado) se lee');
    await rejectsRe(TS.readDocument(Buffer.alloc(25 * 1024 * 1024 + 1, 32), 'enorme.txt'), /supera 25 MB/, '> 25 MB');
    const PDFDocument = require('pdfkit');
    const pdf = (pages) => new Promise((resolve, reject) => {
      const doc = new PDFDocument({ autoFirstPage: false, info: { CreationDate: new Date(0), ModDate: new Date(0) } });
      const parts = [];
      doc.on('data', (c) => parts.push(c)); doc.on('end', () => resolve(Buffer.concat(parts))); doc.on('error', reject);
      for (let i = 0; i < pages; i++) { doc.addPage({ size: [200, 200] }); if (i === 0) doc.fontSize(10).text('Página uno'); }
      doc.end();
    });
    const t0 = Date.now();
    let code = null;
    try { await TS.readPdf(await pdf(601)); } catch (e) { code = e.code; }
    eq(code, 'DOCUMENT_TOO_MANY_PAGES', '601 páginas');
    assert(Date.now() - t0 < 20000, 'se rechaza sin leer todo el texto');
    eq((await TS.readPdf(await pdf(600))).pages, 600, '600 páginas se leen');
    // El cuerpo grande SOLO en las rutas de lectura (misma expresión que main.ts, montada igual: antes del parser general).
    const main = fs.readFileSync(path.join(REPO, 'src/main.ts'), 'utf8');
    const m = main.match(/app\.use\((\/\^\\\/api.*?\$\/), express\.json\(\{ limit: '36mb' \}\)\);\n\s*app\.use\(express\.json\(\{ limit: '10mb' \}\)\);/);
    assert(m, 'main.ts monta 36 MB en la ruta de lectura ANTES del límite general de 10 MB');
    const re = eval(m[1]);
    assert(re.test('/api/v1/courses/12/academic-context/extract') && re.test('/api/v1/courses/12/academic-context/extract-advanced'), 'las dos rutas de lectura');
    for (const p of ['/api/v1/courses/12/academic-context/requirements', '/api/v1/courses/12/design/recommendation', '/api/v1/courses/12/academic-context/extractx', '/api/v1/courses/x/academic-context/extract']) assert(!re.test(p), `no ${p}`);
    const express = require('express');
    const app = express();
    app.use(re, express.json({ limit: '36mb' }));
    app.use(express.json({ limit: '10mb' }));
    app.use((req, res) => res.json({ n: JSON.stringify(req.body).length }));
    app.use((err, req, res, next) => res.status(err.status || 500).end()); // eslint-disable-line no-unused-vars
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const port = server.address().port;
      const body = JSON.stringify({ files: [{ name: 'a.pdf', dataBase64: 'A'.repeat(15 * 1024 * 1024) }] });
      const post = (p) => new Promise((resolve, reject) => {
        const req = require('http').request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject); req.end(body);
      });
      eq(await post('/api/v1/courses/12/academic-context/extract'), 200, '15 MB a /extract');
      eq(await post('/api/v1/courses/12/design/recommendation'), 413, '15 MB a otra ruta');
    } finally { server.close(); }
  });

  if (PURE_ONLY) {
    console.log('\n(--pure-only: parte DB omitida)');
  } else {
    await dbChecks();
  }
  console.log(`\n${passed} OK · ${failed} fallas`);
  process.exit(failed ? 1 : 0);
})();

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

async function dbChecks() {
  console.log('\nParte DB');
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException, Logger } = require('@nestjs/common');
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { PedagogyService } = loadDist('modules/pedagogy/pedagogy.service.js');
  const { CourseDesignService } = loadDist('modules/course-design/course-design.service.js');
  const { AcademicContextService } = loadDist('modules/academic-context/academic-context.service.js');
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-loop86b-pg16-'));
  const DB = 'loop86bdb';
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
        'supabase-migration-application-activities.sql', 'supabase-migration-academic-context.sql']) {
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
    const acx = new AcademicContextService(ds, coursesStub, null, null);
    const structure = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const OTHER = '99999999-8888-4777-8666-555555555555';
    const counter = async (cid) => (await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c;
    // Microcurrículo SINTÉTICO de las fixtures + una tabla de tamaños sintética.
    const microText = F.toText('consistent').toString('utf8') + '\n\n' + SML_TABLE + '\n';
    const file = (name, text) => ({ name, dataBase64: Buffer.from(text, 'utf8').toString('base64') });
    const newCourse = async (title) => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, $2, 'dynamic', true, 'h5p') returning id`, [OWNER, title]);
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'Módulo 1') returning id`, [c.id]);
      await ds.query(`insert into public.course_chapters (course_id, module_id, position, title) values ($1, $2, 0, 'Nuevo capítulo')`, [c.id, m.id]);
      return c.id;
    };
    const saveDraft = async (cid, draft) => {
      await profiles.append(cid, OWNER, 'academic', draft);
      const v = (await profiles.getCurrent(cid, OWNER, 'academic')).version;
      await structure.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: v });
    };

    let cid;
    let gidDb;
    await check('RB9 /extract guarda los requisitos de ESOS documentos; vista none → current; otro documento → stale', async () => {
      cid = await newCourse('Tamaños');
      eq((await acx.requirements(cid, OWNER)).state, 'none', 'sin contexto');
      const ex = await acx.extract(cid, OWNER, { files: [file('micro-tamaños.txt', microText)] });
      eq([ex.requirements.stored, ex.requirements.alternatives], [true, 1], 'la respuesta resume lo leído');
      eq(ex.saved, false, 'el contexto NO se guarda en /extract');
      eq((await acx.requirements(cid, OWNER)).state, 'none', 'sin guardar el contexto, no se muestra nada');
      await saveDraft(cid, ex.draft);
      const v = await acx.requirements(cid, OWNER);
      eq(v.state, 'current', 'contexto de esos documentos');
      eq(v.alternatives.map((a) => [a.label, a.options.map((o) => o.id), a.selected]), [['Tamaño', ['S', 'M', 'L'], null]], 'S/M/L sin elegir');
      eq(v.items.filter((i) => i.applies && i.optionId).length, 0, 'ninguna alternativa activa');
      // El microcurrículo sintético también dice sus horas totales: eso sí aplica (no es una alternativa).
      assert(v.items.some((i) => i.applies && !i.optionId && i.kind === 'target_hours'), 'las horas del documento aplican');
      gidDb = v.alternatives[0].groupId;
      // Otra lectura (otro documento) no pisa la vigente; el contexto guardado sigue siendo el del primero.
      await acx.extract(cid, OWNER, { files: [file('otro.txt', FULL)] });
      eq((await acx.requirements(cid, OWNER)).state, 'current', 'la lectura del primero sigue');
      const meta = (await ds.query(`select metadata -> 'documentRequirements' r from public.courses where id = $1`, [cid]))[0].r;
      eq(meta.entries.length, 2, 'dos lecturas guardadas');
      for (let i = 0; i < 3; i++) await acx.extract(cid, OWNER, { files: [file(`x${i}.txt`, `El curso tendrá ${i + 2} módulos.`)] });
      eq((await ds.query(`select metadata -> 'documentRequirements' r from public.courses where id = $1`, [cid]))[0].r.entries.length, 3, 'como mucho 3');
      eq((await acx.requirements(cid, OWNER)).state, 'stale', 'la lectura del contexto guardado ya salió de las 3: stale (no se inventa)');
      // Releer el documento la recupera.
      await acx.extract(cid, OWNER, { files: [file('micro-tamaños.txt', microText)] });
      eq((await acx.requirements(cid, OWNER)).state, 'current', 'releída');
      await rejectsRe(acx.requirements(cid, OTHER), /not found/i, 'ajeno', 404);
    });

    await check('RB10 elegir alternativa: desconocidos → 400; ajeno → 404; M → activa; quitarla; nunca automática', async () => {
      await rejectsRe(acx.setRequirementSelection(cid, OWNER, 'G99', 'M'), /UNKNOWN_ALTERNATIVE_GROUP/, 'grupo', 400);
      await rejectsRe(acx.setRequirementSelection(cid, OWNER, gidDb, 'XL'), /UNKNOWN_ALTERNATIVE/, 'opción', 400);
      await rejectsRe(acx.setRequirementSelection(cid, OTHER, gidDb, 'M'), /not found/i, 'ajeno', 404);
      const v = await acx.setRequirementSelection(cid, OWNER, gidDb, 'M');
      eq(v.alternatives[0].selected, 'M', 'M');
      const alts = v.items.filter((i) => i.applies && i.optionId);
      assert(alts.length > 0 && alts.every((i) => i.optionId === 'M'), 'de las alternativas, solo M');
      eq((await acx.setRequirementSelection(cid, OWNER, gidDb, null)).alternatives[0].selected, null, 'quitada');
      const c2 = await newCourse('Sin requisitos');
      await rejectsRe(acx.setRequirementSelection(c2, OWNER, gidDb, 'M'), /NO_DOCUMENT_REQUIREMENTS/, 'sin requisitos', 400);
    });

    await check('RB11 «Cursia recomienda» trae la comparación y es SOLO LECTURA (huella, estructura y perfil intactos)', async () => {
      const before = await design.recommend(cid, OWNER, {});
      assert(before.requirements && before.requirements.state === 'current', 'bloque de requisitos');
      eq(before.requirements.checks.map((c) => before.requirements.items.find((i) => i.id === c.requirementId).optionId || null).filter(Boolean), [], 'sin elegir: ninguna alternativa se compara');
      const cnt0 = await counter(cid);
      const struct0 = await ds.query(`select id, position, title from public.course_chapters where course_id = $1 order by id`, [cid]);
      const prof0 = await ds.query(`select count(*)::int n from public.course_profiles where course_id = $1`, [cid]).catch(() => [{ n: -1 }]);
      await acx.setRequirementSelection(cid, OWNER, gidDb, 'M');
      const after = await design.recommend(cid, OWNER, {});
      // 8.6C: la alternativa elegida restringe la propuesta (la huella puede cambiar), pero elegir no escribe nada.
      eq(await counter(cid), cnt0, 'contador de estructura intacto');
      eq(await ds.query(`select id, position, title from public.course_chapters where course_id = $1 order by id`, [cid]), struct0, 'capítulos intactos');
      eq(await ds.query(`select count(*)::int n from public.course_profiles where course_id = $1`, [cid]).catch(() => [{ n: -1 }]), prof0, 'sin perfiles nuevos');
      const ch = after.requirements.checks;
      const item = (k) => after.requirements.items.find((i) => i.applies && i.kind === k && i.optionId === 'M');
      eq(ch.length, after.requirements.items.filter((i) => i.applies).length, 'una comparación por requisito activo');
      const mods = ch.find((c) => c.requirementId === item('modules').id);
      eq(mods.actual.value, after.design.counts.modules, 'módulos del MISMO diseño');
      eq(mods.status, after.design.counts.modules === 3 ? 'met' : 'unmet', 'estado coherente');
      assert(['cursia', 'teacher'].includes(mods.chosenBy), 'quién lo decidió');
      const hrs = ch.find((c) => c.requirementId === item('target_hours').id);
      eq(hrs.actual.value, after.hours.target, 'horas: la meta del diseño');
      // No bloquea: el diseño sigue aplicable aunque se aparte.
      assert(typeof after.design.applicable === 'boolean', 'la propuesta sigue siendo aplicable o no por sus propias razones');
      // Horas del docente en «Ajustar» → «Te estás apartando».
      const adj = await design.recommend(cid, OWNER, { adjust: { targetHours: 30 } });
      const h2 = adj.requirements.checks.find((c) => c.requirementId === item('target_hours').id);
      eq([h2.status, h2.chosenBy, h2.actual.value], ['unmet', 'teacher', 30], '30 h del docente');
    });
    await check('RB13 un PATCH con metadata no borra ni falsifica requisitos ni elección; el listado no arrastra las lecturas', async () => {
      const { CoursesService } = loadDist('modules/courses/courses.service.js');
      const { Course } = loadDist('modules/courses/entities/course.entity.js');
      const { Institution } = loadDist('modules/institutions/entities/institution.entity.js');
      const { CourseVersion } = loadDist('modules/course-versions/entities/course-version.entity.js');
      const ds2 = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [Course, Institution, CourseVersion], synchronize: false });
      await ds2.initialize();
      try {
        const courses = new CoursesService(ds2.getRepository(Course), {});
        await acx.setRequirementSelection(cid, OWNER, gidDb, 'L');
        const meta0 = (await ds.query(`select metadata m from public.courses where id = $1`, [cid]))[0].m;
        await courses.update(cid, { metadata: { courseId: 'abc', documentRequirements: { version: 1, entries: [] }, documentRequirementsSelection: { key: 'x', options: {} } } }, OWNER);
        const meta1 = (await ds.query(`select metadata m from public.courses where id = $1`, [cid]))[0].m;
        eq(meta1.documentRequirements, meta0.documentRequirements, 'requisitos intactos');
        eq(meta1.documentRequirementsSelection, meta0.documentRequirementsSelection, 'elección intacta');
        eq(meta1.courseId, 'abc', 'lo demás del PATCH sí se aplica');
        eq((await acx.requirements(cid, OWNER)).alternatives[0].selected, 'L', 'la vista sigue igual');
        const list = await courses.findAll(OWNER);
        const row = list.find((c) => Number(c.id) === Number(cid));
        assert(row && row.metadata && row.metadata.documentRequirements === undefined, 'el listado no trae las lecturas');
        eq(row.metadata.documentRequirementsSelection, meta0.documentRequirementsSelection, 'el resto del metadata sí');
        eq((await ds.query(`select metadata -> 'documentRequirements' r from public.courses where id = $1`, [cid]))[0].r, meta0.documentRequirements, 'el listado no borra nada');
      } finally { await ds2.destroy(); }
    });
  } catch (err) {
    failed++;
    console.log(`❌ parte DB: ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  } finally {
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const [k, envK] of [['flag', 'DYNAMIC_COURSE_STRUCTURE'], ['allow', 'DYNAMIC_V2_ALLOWED_OWNERS'], ['unowned', 'ALLOW_UNOWNED_COURSES'], ['rules', 'DYNAMIC_MANIFEST_RULES_VERSION'], ['atr', 'DYNAMIC_ACTIVITY_TYPE_RULES']]) {
      if (saved[k] === undefined) delete process.env[envK]; else process.env[envK] = saved[k];
    }
  }
}
