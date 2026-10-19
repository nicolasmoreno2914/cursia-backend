/* eslint-disable */
// T7 (r57) — motor GENÉRICO de la simulación comercial. Una sola función (`simulateCourse`) lleva CUALQUIER curso de
// configuración a paquete validado; los cursos difieren SOLO en su configuración (scripts/fixtures/commercial-
// simulation/courses.json). Este archivo NO conoce ningún curso, cliente ni institución: no hay ramas por id, título ni
// cliente (el check lo verifica leyendo este mismo archivo).
//
//   configuración → perfil pedagógico + de evaluación (validados por el backend real) → dry-run (Prebrief inputs +
//   distribuidor + Manifest materializado + FinOps estimado) → Prebrief → Blueprint (lock) → Manifest v3 → briefs de
//   cada item (lo que recibiría el generador) → artifacts de proveedores FALSOS (scripts/lib/v21-packaging-fixtures.js:
//   salidas simuladas del ejecutor; bancos de examen de scripts/lib/exam-bank-fixtures.js) → buildDynamicMbzV3 →
//   validateMbzV3.
//
// Sin red, sin IA, sin DB, USD 0. Determinista.
'use strict';

const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const C = require('./composition-fixtures');
const PF = require('./v21-packaging-fixtures');
const EBF = require('./exam-bank-fixtures');
const DF = require('./deliverable-fixtures');

const ZIP_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const FIXED_REQUIREMENTS = { noContentAdditions: true, sources: {} };
const LEARNER = { description: 'Personas adultas que se forman en un oficio técnico', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' };

function libs(distRoot) {
  const L = (rel) => require(path.join(distRoot, rel));
  return {
    P: L('modules/pedagogy/index.js'),
    snap: L('modules/course-blueprints/blueprint-snapshot.js'),
    MB: L('modules/generation-manifests/generation-manifest-builder.js'),
    B: L('package/dynamic-mbz-builder-v3.js'),
    VAL: L('package/v3/mbz-validator-v3.js'),
    EB: L('modules/course-shell/exam-bank.js'),
    CP: L('modules/course-profiles/course-profiles.js'),
    PM: L('modules/prebrief/prebrief-model.js'),
    RA: L('modules/academic-context/requirements/requirement-authority.js'),
    PFILES: L('package/v3/practice-files.js'),
    MEDIA: L('package/v3/synthetic-media.js'),
    QR: L('modules/quality/course-quality-report.js'),
  };
}

/** Estructura del curso desde la configuración: capítulos por letra (banco genérico por tipo) o por [título, objetivo]. */
function structureOf(cfg) {
  const used = {};
  let ci = 0;
  const courseId = cfg.courseId;
  return {
    course: { id: courseId, title: cfg.title, finalExam: cfg.finalExam !== false, activityEngine: cfg.engine || 'h5p', reviewCards: cfg.reviewCards !== false },
    modules: cfg.modules.map((mod, mi) => {
      const chapters = typeof mod.chapters === 'string' ? [...mod.chapters] : mod.chapters;
      return {
        id: C.uuid('e', courseId * 10 + mi + 1),
        title: mod.title || `Módulo ${mi + 1}`,
        objective: mod.objective || null,
        examEnabled: mod.examEnabled !== false,
        chapters: chapters.map((spec) => {
          ci++;
          let title;
          let objective;
          if (typeof spec === 'string') {
            const k = used[spec] = (used[spec] ?? -1) + 1;
            const [t, o] = C.BANK[spec][k % C.BANK[spec].length];
            title = `${t}${k >= C.BANK[spec].length ? ` ${Math.floor(k / C.BANK[spec].length) + 1}` : ''}`;
            objective = o;
          } else {
            [title, objective] = spec;
          }
          return { id: C.uuid('f', courseId * 100 + ci), title, objective, videoEnabled: mod.videoEnabled !== false, activityEnabled: mod.activityEnabled !== false };
        }),
      };
    }),
  };
}

/** Perfil pedagógico (enfoque por competencias) + el plan de aprendizaje de la configuración. */
function pedagogyProfileOf(cfg, structure) {
  const pg = cfg.pedagogy || {};
  const plan = pg.learningPlan ? JSON.parse(JSON.stringify(pg.learningPlan)) : null;
  if (plan && plan.chapterOverrides) {
    // Overrides por posición [módulo, capítulo] → id del capítulo (la configuración no conoce los ids).
    const out = {};
    for (const [pos, v] of Object.entries(plan.chapterOverrides)) {
      const [m, c] = pos.split('.').map(Number);
      out[structure.modules[m].chapters[c].id] = v;
    }
    plan.chapterOverrides = out;
  }
  return {
    pedagogyProfileVersion: 1,
    primaryApproach: pg.primaryApproach || 'competencias',
    secondaryApproaches: [],
    learner: { ...LEARNER },
    learningOutcomes: { know: ['Los conceptos básicos del oficio'], do: ['Ejecutar los procedimientos del oficio'], competencies: ['Trabajar con seguridad y criterio'] },
    learningModes: pg.learningModes || ['practice'],
    experienceTypes: pg.experienceTypes || ['practice_experimentation'],
    assessmentMethods: pg.assessmentMethods || ['practical_exercises'],
    principles: [],
    origin: 'manual',
    targetHours: cfg.targetHours,
    ...(plan ? { learningPlan: plan } : {}),
    // r58 (I6): «Ajustar» del docente (designPreferences del perfil: emphasis / applicationActivities / audiovisual /
    // guidedPractice), validado por el backend real como cualquier otro campo del perfil.
    ...(pg.designPreferences ? { designPreferences: JSON.parse(JSON.stringify(pg.designPreferences)) } : {}),
  };
}

/** Lock + Manifest como «Usar este diseño» (mismo cálculo que el dry-run; ver check-composition-formats.js). */
function materialize(X, cfg, profile, dist, structure) {
  const { P, snap, MB } = X;
  const rules = P.deriveDesignRules(P.normalizePedagogicalProfile(profile));
  let base = P.snapshotFromStructure(structure);
  base = P.withTargetHours(base, cfg.targetHours);
  const ac = P.profileApplicationContext(profile);
  if (ac) base = P.withApplicationContext(base, ac);
  const lockShaped = P.applyPedagogyToSnapshot(base, rules);
  const plain = P.materializeDistribution(lockShaped, dist, ac);
  const locked = P.applyPedagogyToSnapshot(plain, rules);
  const source = { courseId: locked.course.id, blueprintId: 1, blueprintNumber: 1, blueprintSha256: snap.snapshotSha256V2(locked) };
  const manifest = MB.buildGenerationManifestV3(locked, source, { activityTypeRules: 2 });
  return { locked, source, manifest, errors: MB.validateGenerationManifestV3(manifest, locked, source) };
}

/** PPTX mínimo válido (lo que «subiría» el docente; Cursia no genera PowerPoint). */
async function minimalPptx(title) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>'],
    ['ppt/_rels/presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'],
    ['ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'],
    ['ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Título"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${esc(title)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`],
  ];
  const z = new JSZip();
  for (const [n, d] of files) z.file(n, d, { date: ZIP_DATE, createFolders: false });
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};

/** Bytes de un archivo «subido» por el docente (formato de la configuración; contenido sintético y determinista). */
async function uploadBytes(X, file) {
  if (file.format === 'xlsx') return X.PFILES.tableToXlsx(file.columns || ['Columna', 'Valor'], file.rows || [['A', 1]]);
  if (file.format === 'docx') return DF.minimalDocx(file.title || 'Plantilla', file.lines || ['1. Situación', '2. Análisis', '3. Propuesta']);
  if (file.format === 'pptx') return minimalPptx(file.title || 'Presentación de trabajo');
  if (file.format === 'pdf') return X.MEDIA.syntheticPdf(file.pages || 2);
  throw new Error(`formato de archivo no soportado en la simulación: ${file.format}`);
}

/** Capítulo referido por la configuración: {m, c} (posición en la estructura) o {app: n} (n-ésimo capítulo con AA). */
function chapterRef(ref, structure, manifest) {
  if (ref && ref.app !== undefined) {
    const apps = manifest.items.filter((i) => i.type === 'application_activity').map((i) => i.chapterId);
    if (ref.app >= apps.length) throw new Error(`la configuración pide la AA #${ref.app} y el curso tiene ${apps.length}`);
    return apps[ref.app];
  }
  return structure.modules[ref.m].chapters[ref.c].id;
}

/** Perfil de evaluación: el default del producto + lo que pide la configuración (validado por el backend real). */
async function assessmentOf(X, cfg, structure, manifest) {
  const a = cfg.assessment || {};
  const finalExam = cfg.finalExam !== false;
  const profile = JSON.parse(JSON.stringify(X.CP.defaultAssessmentProfile({ finalExam })));
  for (const k of ['passingGrade', 'categoryWeights', 'attempts', 'overrides', 'applicationDelivery', 'teacherGuide']) {
    if (a[k] !== undefined) profile[k] = typeof a[k] === 'object' && !Array.isArray(a[k]) && profile[k] && typeof profile[k] === 'object' ? { ...profile[k], ...JSON.parse(JSON.stringify(a[k])) } : JSON.parse(JSON.stringify(a[k]));
  }
  const files = new Map();
  if (a.practiceResources && a.practiceResources.length) {
    profile.practiceResources = [];
    let n = 0;
    for (const r of a.practiceResources) {
      n++;
      const chapterId = chapterRef(r.chapter, structure, manifest);
      const base = { id: r.id, chapterId, title: r.title, instructions: r.instructions || '', relation: r.relation };
      if (r.table) {
        profile.practiceResources.push({ ...base, source: { kind: 'table', format: r.table.format, filename: r.table.filename, columns: r.table.columns, rows: r.table.rows } });
      } else {
        const buf = await uploadBytes(X, r.file);
        files.set(r.id, buf);
        profile.practiceResources.push({ ...base, source: { kind: 'artifact', artifactId: `aaaaaaaa-0000-4000-8000-${String(cfg.courseId).padStart(8, '0')}${String(n).padStart(4, '0')}`, filename: r.file.filename, mimetype: MIME[r.file.format], bytes: buf.length, sha256: sha256(buf) } });
      }
    }
  }
  const errors = X.CP.validateProfile('assessment', profile, { finalExam });
  if (errors.length) throw new Error(`perfil de evaluación inválido: ${JSON.stringify(errors.slice(0, 4))}`);
  return { profile: X.CP.normalizeProfile('assessment', profile), files };
}

/** Bancos de examen (slots aleatorios) válidos para el Manifest, con la evidencia en el Markdown de cada capítulo. */
function attachExamBanks(X, input) {
  const manifest = input.manifest;
  const content = manifest.modules.flatMap((m) => m.chapters.filter((c) => c.kind !== 'practice').map((c) => ({ id: c.chapterId, moduleId: m.moduleId })));
  const gIndex = new Map(content.map((c, i) => [c.id, i]));
  const c = input.contents;
  for (const ch of content) c.contentMd.set(ch.id, `${c.contentMd.get(ch.id)}\n\n${EBF.chapterMarkdown(gIndex.get(ch.id), 'Reglas')}`);
  const banks = new Map();
  for (const m of manifest.modules) {
    if (!m.examEnabled) continue;
    const chs = content.filter((x) => x.moduleId === m.moduleId);
    const bank = EBF.makeExamBank({ scope: 'module', moduleId: m.moduleId, chapters: chs, chapterIndex: gIndex, prefix: `E${m.moduleNumber}L`, plan: X.EB.expectedExamPlan('module', chs) });
    const r = X.EB.validateExamBank(bank, { scope: 'module', chapters: chs, chapterMd: c.contentMd });
    if (!r.ok) throw new Error(`banco simulado inválido (${m.moduleId}): ${JSON.stringify(r.errors.slice(0, 3))}`);
    banks.set(m.moduleId, bank);
  }
  c.examGift = new Map();
  c.examBanks = banks;
  if (manifest.features.finalExam) {
    const fin = EBF.makeExamBank({ scope: 'final', moduleId: null, chapters: content, chapterIndex: gIndex, prefix: 'FL', plan: X.EB.expectedExamPlan('final', content) });
    const r = X.EB.validateExamBank(fin, { scope: 'final', chapters: content, chapterMd: c.contentMd });
    if (!r.ok) throw new Error(`banco final simulado inválido: ${JSON.stringify(r.errors.slice(0, 3))}`);
    c.finalExamGift = null;
    c.finalExamBank = fin;
  }
}

/** GIFT fijos del tamaño del plan (examSlotSplit), como la salida del generador de exámenes en modo GIFT. */
function attachExamGift(X, input) {
  const manifest = input.manifest;
  for (const mod of manifest.modules) {
    if (!mod.examEnabled) continue;
    const n = mod.chapters.filter((c) => c.kind !== 'practice').length;
    input.contents.examGift.set(mod.moduleId, C.giftOf(`M${mod.moduleNumber}`, X.EB.examSlotSplit(n)));
  }
  if (manifest.features.finalExam) {
    const content = manifest.modules.reduce((n, m) => n + m.chapters.filter((c) => c.kind !== 'practice').length, 0);
    input.contents.finalExamGift = C.giftOf('F', X.EB.finalExamSlotSplit(content));
  }
}

/**
 * r58 (I1): la parte de simulateCourse ANTES de los artifacts — configuración → perfiles validados → dry-run → Prebrief →
 * Blueprint (lock) → Manifest v3 → briefs → perfil de evaluación. La comparten la simulación comercial y el driver
 * offline de componentes (scripts/lib/offline-driver.js): un solo camino de la configuración al Manifest.
 * @returns {{ X, cfg, structure, profile, dryRun, prebrief, locked, manifest, briefs, assessment }}
 */
async function prepareCourse(distRoot, cfg) {
  const X = libs(distRoot);
  const structure = C.plainStructure(structureOf(cfg));
  const profile = pedagogyProfileOf(cfg, structure);
  const pErr = X.CP.validateProfile('pedagogy', profile, { finalExam: cfg.finalExam !== false });
  if (pErr.length) throw new Error(`perfil pedagógico inválido: ${JSON.stringify(pErr.slice(0, 4))}`);
  // Distribuidor (dry-run del diseño): mismo cálculo que «Usar este diseño».
  // r58 (I6): lo fijado a mano por el docente en el editor (courses.metadata.designPins), por posición «m.c» → id.
  let designPins = null;
  if (cfg.designPins) {
    designPins = {};
    for (const [pos, v] of Object.entries(cfg.designPins)) {
      const [mi, ci] = pos.split('.').map(Number);
      designPins[structure.modules[mi].chapters[ci].id] = JSON.parse(JSON.stringify(v));
    }
  }
  const dryRun = X.P.runPedagogyDryRun({ structure, profile, activityTypeRules: 2, requirementConstraints: FIXED_REQUIREMENTS, ...(designPins ? { designPins } : {}) });
  const d = dryRun.distribution;
  if (d.materialized.manifestErrors.length) throw new Error(`Manifest materializado con errores: ${JSON.stringify(d.materialized.manifestErrors.slice(0, 3))}`);
  // Prebrief: la tarjeta que aprobaría la institución (diseño + totales del Manifest).
  const { fixture: prebriefFixture } = require('../fixtures/prebrief-fixtures.js');
  const inp = prebriefFixture({ format: cfg.format || null, targetHours: cfg.targetHours });
  inp.card.hours = { target: cfg.targetHours, source: 'user' };
  inp.card.design = {
    status: d.status, estimatedHours: d.estimatedHours, baseHours: d.baseHours, applicable: true, changes: [],
    counts: { modules: d.counts.modules, chapters: d.counts.chapters, evaluations: d.counts.evaluations },
    modules: d.modules.map((m) => ({ id: m.id, title: m.title, examEnabled: m.examEnabled, chapters: m.chapters.map((c) => ({ ...c, hours: c.targetMinutes / 60, outcomeIds: ['RA1'] })) })),
  };
  inp.card.manifestTotals = { ...d.materialized.totals };
  const prebrief = X.PM.buildPrebriefModel(inp, X.RA.actualText, X.RA.requirementText);
  // Blueprint + Manifest.
  const m = materialize(X, cfg, profile, d, structure);
  if (m.errors.length) throw new Error(`Manifest: ${JSON.stringify(m.errors.slice(0, 3))}`);
  if (X.snap.snapshotSha256V2(m.locked) !== d.materialized.blueprintSha256) throw new Error('Blueprint distinto del dry-run');
  // Briefs de cada item (lo que recibiría el generador real).
  const briefs = new Map();
  for (const it of m.manifest.items) {
    const b = X.P.buildItemPedagogyBrief({ item: it, snapshot: m.locked, activityTypeRules: 2 });
    if (b) briefs.set(it.key, b);
  }
  // Perfil de evaluación.
  const assessment = await assessmentOf(X, cfg, structure, m.manifest);
  return { X, cfg, structure, profile, dryRun, prebrief, locked: m.locked, manifest: m.manifest, briefs, assessment };
}

/**
 * Lleva UNA configuración de curso a paquete validado. Mismo código para todos los cursos.
 * @returns {{ cfg, structure, profile, dryRun, prebrief, locked, manifest, briefs, assessment, input, built, validation }}
 */
async function simulateCourse(distRoot, cfg) {
  const { X, structure, profile, dryRun, prebrief, locked, manifest, briefs, assessment } = await prepareCourse(distRoot, cfg);
  const m = { locked, manifest };
  // Artifacts de proveedores falsos.
  const input = PF.packagingInput(distRoot, { snapshot: m.locked, manifest: m.manifest, engine: cfg.engine || 'h5p', finalExam: cfg.finalExam !== false, profile: assessment.profile });
  if (assessment.files.size) input.contents.practiceFiles = assessment.files;
  if ((cfg.exams || 'bank') === 'bank') attachExamBanks(X, input);
  else attachExamGift(X, input);
  const built = await X.B.buildDynamicMbzV3(input);
  const validation = await X.VAL.validateMbzV3(built.mbz, built.expectations);
  return { cfg, structure, profile, dryRun, prebrief, locked: m.locked, manifest: m.manifest, briefs, assessment, input, built, validation, builderVersion: X.B.DYNAMIC_MBZ_BUILDER_VERSION_V3 };
}

/**
 * r58 (I6): el informe de calidad del paquete simulado, con la MISMA llamada que el worker de empaque y el driver offline
 * (buildPackageQualityReport). `override` permite sembrar defectos (contenidos o hallazgos del validador) en un check.
 */
function qualityReportOf(distRoot, sim, override = {}) {
  const X = libs(distRoot);
  return X.QR.buildPackageQualityReport({
    manifest: sim.manifest, blueprint: sim.locked, contents: override.contents || sim.input.contents,
    packageWarnings: [...(sim.built.summary.warnings || []), ...(sim.built.summary.qualityWarnings || [])],
    practiceResources: sim.built.summary.practiceResources || null,
    practiceTitles: new Map(((sim.assessment.profile && sim.assessment.profile.practiceResources) || []).map((r) => [r.id, r.title])),
    hoursReport: sim.built.expectations.facts.hoursReport || null,
    builderVersion: sim.built.summary.builderVersion,
    ...(override.mbzIssues ? { mbzIssues: override.mbzIssues } : {}),
  });
}

/** Inventario del .mbz por modname (moodle_backup.xml) + datos de cada actividad H5P (tracking, nota, completion). */
async function inspectMbz(mbz) {
  const z = await JSZip.loadAsync(mbz);
  const mb = await z.file('moodle_backup.xml').async('string');
  const acts = [...mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>\d+<\/sectionid>\s*<modulename>(\w+)<\/modulename>/g)].map((x) => ({ moduleid: Number(x[1]), modname: x[2] }));
  const byModname = {};
  for (const a of acts) byModname[a.modname] = (byModname[a.modname] || 0) + 1;
  const tag = (x, t) => { const r = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(x); return r ? r[1] : null; };
  const h5p = [];
  for (const a of acts.filter((x) => x.modname === 'h5pactivity')) {
    const dir = `activities/h5pactivity_${a.moduleid}`;
    const xml = await z.file(`${dir}/h5pactivity.xml`).async('string');
    const mod = await z.file(`${dir}/module.xml`).async('string');
    const grades = z.file(`${dir}/grades.xml`) ? await z.file(`${dir}/grades.xml`).async('string') : '';
    h5p.push({ idnumber: tag(mod, 'idnumber'), grade: Number(tag(xml, 'grade')), enabletracking: Number(tag(xml, 'enabletracking')), completion: Number(tag(mod, 'completion')), completionview: Number(tag(mod, 'completionview')), hasGradeItem: /<grade_item /.test(grades) });
  }
  const quizzes = [];
  for (const a of acts.filter((x) => x.modname === 'quiz')) {
    const dir = `activities/quiz_${a.moduleid}`;
    const xml = await z.file(`${dir}/quiz.xml`).async('string');
    const mod = await z.file(`${dir}/module.xml`).async('string');
    const inst = [...xml.matchAll(/<question_instance id="\d+">([\s\S]*?)<\/question_instance>/g)].map((m) => m[1]);
    quizzes.push({ idnumber: tag(mod, 'idnumber'), slots: inst.length, randomSlots: inst.filter((x) => /<question_set_reference /.test(x)).length, attempts: Number(tag(xml, 'attempts_number')) });
  }
  const pages = [];
  for (const a of acts.filter((x) => x.modname === 'page' || x.modname === 'assign' || x.modname === 'resource')) {
    const mod = await z.file(`activities/${a.modname}_${a.moduleid}/module.xml`).async('string');
    pages.push({ modname: a.modname, idnumber: tag(mod, 'idnumber'), visible: Number(tag(mod, 'visible')), hasRubric: a.modname === 'assign' && !!z.file(`activities/assign_${a.moduleid}/grading.xml`) });
  }
  // r58 (I6): insignias del curso (badges.xml) y criterios de finalización del curso (raíz del
  // backup: completion.xml).
  const badgesXml = z.file('badges.xml') ? await z.file('badges.xml').async('string') : '';
  const badges = (badgesXml.match(/<badge id=/g) || []).length;
  const ccXml = z.file('completion.xml') ? await z.file('completion.xml').async('string') : '';
  const completionCriteria = [...ccXml.matchAll(/<criteriatype>(\d+)<\/criteriatype>/g)].map((m) => Number(m[1]));
  return { byModname, h5p, quizzes, pages, badges, completionCriteria };
}

module.exports = { simulateCourse, prepareCourse, attachExamGift, inspectMbz, qualityReportOf, structureOf, pedagogyProfileOf, minimalPptx, sha256, MIME };
