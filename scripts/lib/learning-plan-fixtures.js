/* eslint-disable */
// T2 (r57) — fixtures del plan de aprendizaje (tipo de aprendizaje por capítulo + marco instruccional).
// Curso GENÉRICO («Curso procedimental de ejemplo»): ningún cliente, institución ni curso real. Todo
// determinista; sin red, sin IA, sin DB. Lo usan check-learning-plan.js y la generación del golden
// de compatibilidad (scripts/fixtures/learning-plan/golden-off.json, calculado con el código ANTERIOR).
'use strict';

const crypto = require('crypto');
const path = require('path');

const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v), 'utf8').digest('hex');
const uuid = (prefix, n) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, '0')}`;

/** Estructura: 3 módulos; objetivos que cubren los seis tipos de aprendizaje; un capítulo de práctica. */
const STRUCTURE = {
  course: { id: 9101, title: 'Curso procedimental de ejemplo', finalExam: true, activityEngine: 'h5p', reviewCards: false },
  modules: [
    {
      id: uuid('a', 1), title: 'Fundamentos', objective: 'Explicar los conceptos básicos del oficio', examEnabled: true,
      chapters: [
        { id: uuid('c', 1), title: 'Conceptos clave del oficio', objective: 'Explicar los conceptos y principios básicos del oficio', videoEnabled: true, activityEnabled: true },
        { id: uuid('c', 2), title: 'Marco normativo del oficio', objective: 'Aplicar la normativa vigente y los deberes éticos en casos del oficio', videoEnabled: false, activityEnabled: true },
        { id: uuid('c', 3), title: 'Procedimiento de preparación', objective: 'Ejecutar paso a paso el procedimiento de preparación del puesto', videoEnabled: true, activityEnabled: true, applicationMinutes: 60 },
      ],
    },
    {
      id: uuid('a', 2), title: 'Operación segura', objective: 'Aplicar los protocolos de seguridad', examEnabled: true,
      chapters: [
        { id: uuid('c', 4), title: 'Protocolo de emergencia', objective: 'Activar el protocolo de emergencia y evacuación del área', videoEnabled: true, activityEnabled: true },
        { id: uuid('c', 5), title: 'Decisiones ante incidentes', objective: 'Decidir la mejor alternativa ante situaciones de riesgo', videoEnabled: false, activityEnabled: true, guidedPracticeMinutes: 40 },
        { id: uuid('c', 6), title: 'Práctica integradora del módulo', objective: 'Resolver casos que integran el módulo', kind: 'practice', activityEnabled: true },
      ],
    },
    {
      id: uuid('a', 3), title: 'Relación con las personas', objective: null, examEnabled: false,
      chapters: [
        { id: uuid('c', 7), title: 'Comunicación con el usuario', objective: 'Comunicar instrucciones con escucha activa y empatía', videoEnabled: true, activityEnabled: true },
        { id: uuid('c', 8), title: 'Registro de la jornada', objective: 'Registrar los datos de la jornada en la hoja de cálculo', videoEnabled: false, activityEnabled: false },
      ],
    },
  ],
};

const LEARNER = { description: 'Personas adultas que se forman en un oficio técnico', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' };

/** Perfil base (enfoque por competencias) SIN plan de aprendizaje. */
function baseProfile(extra = {}) {
  return {
    pedagogyProfileVersion: 1,
    primaryApproach: 'competencias',
    secondaryApproaches: [],
    learner: { ...LEARNER },
    learningOutcomes: { know: ['Los conceptos básicos del oficio'], do: ['Ejecutar el procedimiento de preparación'], competencies: ['Trabajar con seguridad'] },
    learningModes: ['practice'],
    experienceTypes: ['practice_experimentation'],
    assessmentMethods: ['practical_exercises'],
    principles: [],
    origin: 'manual',
    ...extra,
  };
}

/** Curso para el shell (sin práctica ni AA: los metadatos medidos del fixture del shell no los cubren). */
function shellStructure() {
  return {
    course: { id: 9102, title: 'Curso procedimental de ejemplo', finalExam: true, activityEngine: 'h5p' },
    modules: [
      { id: uuid('b', 1), title: 'Bases', examEnabled: true, chapters: [
        { id: uuid('d', 1), title: 'Conceptos clave del oficio', objective: 'Explicar los conceptos básicos del oficio', videoEnabled: true, activityEnabled: true },
        { id: uuid('d', 2), title: 'Procedimiento de preparación', objective: 'Ejecutar paso a paso el procedimiento de preparación', videoEnabled: false, activityEnabled: true },
      ] },
      { id: uuid('b', 2), title: 'Aplicación', examEnabled: false, chapters: [
        { id: uuid('d', 3), title: 'Protocolo de emergencia', objective: 'Activar el protocolo de emergencia', videoEnabled: true, activityEnabled: false },
        { id: uuid('d', 4), title: 'Decisiones ante incidentes', objective: 'Decidir ante situaciones de riesgo', videoEnabled: false, activityEnabled: false },
      ] },
    ],
  };
}

function load(distRoot, rel) {
  return require(path.join(distRoot, rel));
}

/** Snapshot con diseño pedagógico (lo que congela el lock) + Manifest v3 con las reglas indicadas. */
function lockAndManifest(distRoot, structure, profile, activityTypeRules = 2) {
  const P = load(distRoot, 'modules/pedagogy/index.js');
  const snap = load(distRoot, 'modules/course-blueprints/blueprint-snapshot.js');
  const B = load(distRoot, 'modules/generation-manifests/generation-manifest-builder.js');
  const plain = P.snapshotFromStructure(structure);
  const ped = P.lockPedagogyInput(plain, profile);
  const rows = snap.snapshotV2ToRows(plain);
  const snapshot = snap.buildBlueprintSnapshotV2(rows.course, rows.modules, rows.chapters, ped);
  const source = { courseId: structure.course.id, blueprintId: 1, blueprintNumber: 1, blueprintSha256: snap.snapshotSha256V2(snapshot) };
  const manifest = B.buildGenerationManifestV3(snapshot, source, { activityTypeRules });
  return { snapshot, source, manifest, errors: B.validateGenerationManifestV3(manifest, snapshot, source) };
}

/** Huellas de compatibilidad de TODO lo que el plan podría tocar (perfil, lock, Manifest, briefs, huellas, dry-run, shell). */
function compatDigests(distRoot, profile) {
  const P = load(distRoot, 'modules/pedagogy/index.js');
  const B = load(distRoot, 'modules/generation-manifests/generation-manifest-builder.js');
  const snap = load(distRoot, 'modules/course-blueprints/blueprint-snapshot.js');
  const FP = load(distRoot, 'modules/invalidation/fingerprints.js');
  const S = load(distRoot, 'modules/course-shell/index.js');
  const te = load(distRoot, 'modules/theme-engine/index.js');
  const cp = load(distRoot, 'modules/course-profiles/course-profiles.js');
  const SF = require('./v21-shell-fixtures');
  const out = {};
  const norm = P.normalizePedagogicalProfile(profile);
  out.profile = sha(norm);
  out.profileSha256 = P.pedagogicalProfileSha256(norm);
  out.rules = sha(P.designRulesRecord(P.deriveDesignRules(profile)));
  for (const rules of [0, 1, 2]) {
    const lm = lockAndManifest(distRoot, STRUCTURE, profile, rules);
    if (lm.errors.length) throw new Error(`manifest inválido (reglas ${rules}): ${JSON.stringify(lm.errors.slice(0, 2))}`);
    out[`snapshot.r${rules}`] = snap.snapshotSha256V2(lm.snapshot);
    out[`manifest.r${rules}`] = B.manifestSha256(lm.manifest);
    const briefs = lm.manifest.items.map((it) => {
      const b = P.buildItemPedagogyBrief({ item: it, snapshot: lm.snapshot, activityTypeRules: lm.manifest.features.activityTypeRules ?? null });
      return [it.key, b];
    });
    out[`briefs.r${rules}`] = sha(briefs);
    const fps = FP.computeFingerprintsV3(lm.snapshot, { courseContextSha256: null });
    out[`fingerprints.r${rules}`] = sha(lm.manifest.items.map((it) => [it.key, FP.itemFingerprintV3(fps, it.key, { ...(it.variant ? { variant: it.variant } : {}), ...(it.h5pType ? { h5pType: it.h5pType } : {}), ...(it.type === "video_interactions" ? { videoIdentity: "fixture-video" } : {}) })]));
  }
  // Sin perfil: el camino de siempre (el plan nunca existe sin enfoque).
  const plain = P.snapshotFromStructure(STRUCTURE);
  out.noProfile = snap.snapshotSha256V2(plain);
  const dr = P.runPedagogyDryRun({ structure: STRUCTURE, profile, activityTypeRules: 2 });
  out.dryRun = sha(dr);
  out.dryRunNoProfile = sha(P.runPedagogyDryRun({ structure: STRUCTURE, profile: null, activityTypeRules: 2 }));
  // Shell: facts + todos los labels de todos los capítulos (con diseño pedagógico, sin plan).
  const sh = lockAndManifest(distRoot, shellStructure(), profile, 2);
  const facts = S.buildCourseFacts({ manifest: sh.manifest, blueprint: sh.snapshot, assessment: cp.defaultAssessmentProfile({ finalExam: true }), artifacts: SF.measuredArtifacts(sh.manifest) });
  out.facts = sha(facts);
  const theme = te.resolveTheme(SF.THEME_COMBOS[0]);
  out.shell = sha(S.assembleAllChapters(facts, SF.experiencesFor(sh.manifest), theme));
  return out;
}

module.exports = { sha, uuid, STRUCTURE, LEARNER, baseProfile, shellStructure, lockAndManifest, compatDigests };
