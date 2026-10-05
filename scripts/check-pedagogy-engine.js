#!/usr/bin/env node
/* eslint-disable */
// Motor pedagógico V1 — check sin Jest, contra el código COMPILADO en dist/
// (correr "npm run build" antes). Sin red, sin proveedores, sin gasto.
//
// Parte pura (siempre): las 13 pruebas del criterio de terminado + extras
//   T1  cada enfoque produce reglas diferentes
//   T2  las reglas llegan al Blueprint
//   T3  las reglas llegan al Manifest (y el validador lo exige)
//   T4  cambiar el enfoque cambia el diseño
//   T5  el generador funciona sin perfil (Blueprint/Manifest/huellas byte-idénticos a staging)
//   T6  un perfil vacío conserva el comportamiento anterior
//   T7  las actividades corresponden al enfoque
//   T8  la evaluación corresponde al enfoque
//   T9  videos y recursos cambian según el enfoque
//   T10 el dry-run nunca llama proveedores (proceso aislado con TODA la red bloqueada)
//   T11 «No estoy seguro» produce una recomendación válida
//   T12 se pueden combinar enfoques
//   T13 un enfoque nuevo no requiere modificar el motor
// Parte DB (default; se salta SOLO con --pure-only, y lo dice): Postgres 16
// local y desechable; migración real + servicios compilados (perfiles, lock
// del Blueprint v2, dry-run del curso).
//
// Usage: node scripts/check-pedagogy-engine.js [--pure-only] [path/to/dist]

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
const FIX = path.join(REPO, 'scripts/fixtures/pedagogy');

function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

const P = loadDist('modules/pedagogy/index.js');
const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const mb = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const fp = loadDist('modules/invalidation/fingerprints.js');
const profilesPure = loadDist('modules/course-profiles/course-profiles.js');

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ❌ ${name}\n      ${String((err && err.stack) || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}: esperado ${jb}, obtenido ${ja}`);
}
function throwsRe(fn, re, msg) {
  try { fn(); } catch (e) { if (re.test(String(e.message))) return; throw new Error(`${msg}: error inesperado ${e.message}`); }
  throw new Error(`${msg}: no lanzó`);
}
async function rejectsRe(p, re, msg, status) {
  try { await p; } catch (e) {
    const text = String(e?.response?.message ?? e?.message ?? e) + ' ' + JSON.stringify(e?.response ?? '');
    if (!re.test(text)) throw new Error(`${msg}: error inesperado ${text}`);
    if (status !== undefined && e?.status !== status && e?.getStatus?.() !== status) throw new Error(`${msg}: status ${e?.status} ≠ ${status}`);
    return;
  }
  throw new Error(`${msg}: no rechazó`);
}
/** Copia con las claves de todos los objetos en orden inverso (simula jsonb). */
function shuffleKeys(v) {
  if (Array.isArray(v)) return v.map(shuffleKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).reverse()) out[k] = shuffleKeys(v[k]);
    return out;
  }
  return v;
}

const RCP = JSON.parse(fs.readFileSync(path.join(FIX, 'rcp-course.json'), 'utf8'));
const PF = JSON.parse(fs.readFileSync(path.join(FIX, 'profiles.json'), 'utf8'));
const APPROACHES = ['competencias', 'problemas', 'experiencial', 'significativo', 'autodirigido'];

function profileOf(key) {
  const p = PF.profiles[key];
  return {
    pedagogyProfileVersion: 1,
    primaryApproach: p.primaryApproach,
    secondaryApproaches: p.secondaryApproaches,
    learner: p.learner || PF.learner,
    learningOutcomes: PF.outcomes,
    learningModes: [],
    experienceTypes: [],
    assessmentMethods: [],
    principles: [],
    origin: 'manual',
  };
}

/** Pins (calculados con el código de origin/staging 8716669, SIN el motor pedagógico): el camino sin perfil no puede cambiar. */
const PINS = {
  blueprintSha: '03090598288865a5c700434087f8ace57744cef49e99fcbcd1a6d9d956934f07',
  manifestSha_r0: '31a84e666e2be215ed5e40a08aa7b6cad6873d26fce490fb88122c3262b188b6',
  manifestSha_r1: '1bfd09a1d34c56cb87b9ea7096a2d0a3209ea9b07fc925e7207d56b032c58e90',
  manifestSha_r2: 'aafda77d20d55a78d87218211a177609ff037e37027862bc60138a42d296c3f2',
  fpCourseOutline: 'a4d9e4696d0eda5d6332800345a3d6ccd8f69e0353869a216e24005111c62016',
  fpFinalExam: '7ad800235b5e0e7d94380f8f9eae2d0cf3f4e3af6a55d9c8ffc9fbe5463727ed',
  fpContentFull1: '69fd33a9bf358b8eee953cc2d5cbfbe84c78794aa456cec2e42555cc3dab7c99',
};
const SOURCE = (sha) => ({ courseId: 9001, blueprintId: 7, blueprintNumber: 3, blueprintSha256: sha });

function plainSnapshot() {
  return P.snapshotFromStructure(RCP);
}
function pedSnapshot(key) {
  return P.applyPedagogyToSnapshot(plainSnapshot(), P.deriveDesignRules(profileOf(key)));
}

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  console.log('\nParte pura');

  // ── Perfil ───────────────────────────────────────────────────────────────
  await check('Perfil: 5 enfoques iniciales en el registro, todos válidos contra el vocabulario', () => {
    eq(P.defaultApproachRegistry().ids(), APPROACHES, 'ids');
    for (const a of P.BUILTIN_APPROACHES) eq(P.validateApproachDefinition(a), [], `enfoque ${a.id}`);
  });
  await check('Perfil: estructura completa (enfoques, estudiante, resultados, forma de aprender, experiencia, evaluación, principios)', () => {
    const p = profileOf('competencias+experiencial');
    eq(P.validatePedagogicalProfile(p), [], 'válido');
    const n = P.normalizePedagogicalProfile(p);
    for (const k of ['primaryApproach', 'secondaryApproaches', 'learner', 'learningOutcomes', 'learningModes', 'experienceTypes', 'assessmentMethods', 'principles', 'origin']) assert(k in n, `falta ${k}`);
    for (const k of ['description', 'ageGroup', 'educationLevel', 'priorKnowledge', 'experience']) assert(k in n.learner, `learner.${k}`);
    for (const k of ['know', 'do', 'competencies']) assert(Array.isArray(n.learningOutcomes[k]), `outcomes.${k}`);
  });
  await check('Perfil: validación fail-loud (enfoque desconocido, secundario = principal, >2 secundarios, campo desconocido, opción inválida)', () => {
    const base = profileOf('competencias');
    const codes = (p) => P.validatePedagogicalProfile(p).map((e) => e.code);
    assert(codes({ ...base, primaryApproach: 'conductismo' }).includes('UNKNOWN_APPROACH'), 'desconocido');
    assert(codes({ ...base, secondaryApproaches: ['competencias'] }).includes('SECONDARY_EQUALS_PRIMARY'), 'secundario=principal');
    assert(codes({ ...base, secondaryApproaches: ['problemas', 'experiencial', 'significativo'] }).includes('TOO_MANY_SECONDARY'), '>2');
    assert(codes({ ...base, pedagogy: 'constructivism' }).includes('UNKNOWN_FIELD'), 'campo desconocido');
    assert(codes({ ...base, learningModes: ['magia'] }).includes('INVALID_OPTION'), 'opción');
    assert(codes({ ...base, primaryApproach: null, secondaryApproaches: ['problemas'] }).includes('SECONDARY_WITHOUT_PRIMARY'), 'secundario sin principal');
    throwsRe(() => P.normalizePedagogicalProfile({ ...base, primaryApproach: 'x' }), /PROFILE_INVALID/, 'normalize lanza');
    // «pedagogy = constructivism» solo: no es un perfil.
    assert(P.validatePedagogicalProfile({ pedagogy: 'constructivism' }).length > 3, 'string suelto no es perfil');
  });
  await check('Perfil: normalización independiente del orden (opciones y claves) → mismo sha; designRules del cliente se ignora', () => {
    const a = { ...profileOf('competencias'), learningModes: ['practice', 'concepts'], assessmentMethods: ['cases', 'quizzes'] };
    const b = shuffleKeys({ ...a, learningModes: ['concepts', 'practice'], assessmentMethods: ['quizzes', 'cases'], designRules: { hack: true } });
    eq(P.pedagogicalProfileSha256(P.normalizePedagogicalProfile(a)), P.pedagogicalProfileSha256(P.normalizePedagogicalProfile(b)), 'sha');
    eq(profilesPure.profileSha256(profilesPure.normalizeProfile('pedagogy', b)), P.pedagogicalProfileSha256(P.normalizePedagogicalProfile(a)), 'course-profiles despacha pedagogy');
    eq(profilesPure.validateProfile('pedagogy', a, { finalExam: true }), [], 'validateProfile(pedagogy)');
    eq(profilesPure.PROFILE_KINDS, ['presentation', 'assessment', 'pedagogy'], 'kinds');
  });
  await check('Perfil: reglas derivadas son determinísticas y representables (designRulesRecord)', () => {
    const r1 = P.deriveDesignRules(profileOf('problemas+significativo+autodirigido'));
    const r2 = P.deriveDesignRules(shuffleKeys(profileOf('problemas+significativo+autodirigido')));
    eq(r1, r2, 'determinístico');
    const rec = P.designRulesRecord(r1);
    assert(rec.engineVersion === 1 && rec.appliedRuleIds.length > 10 && rec.sequence.length > 5, 'record');
  });

  // ── T1 ───────────────────────────────────────────────────────────────────
  await check('T1 cada enfoque produce reglas diferentes (metas, secuencia y verbos distintos de a pares)', () => {
    const rules = APPROACHES.map((a) => P.deriveDesignRules(profileOf(a)));
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const diffTargets = Object.keys(rules[i].targets).filter((t) => rules[i].targets[t] !== rules[j].targets[t]);
        assert(diffTargets.length >= 8, `${APPROACHES[i]} vs ${APPROACHES[j]}: solo ${diffTargets.length} metas distintas`);
        assert(JSON.stringify(rules[i].sequence) !== JSON.stringify(rules[j].sequence), `${APPROACHES[i]} vs ${APPROACHES[j]}: misma secuencia`);
        assert(rules[i].objectiveVerbs[0] !== rules[j].objectiveVerbs[0], `${APPROACHES[i]} vs ${APPROACHES[j]}: mismo verbo`);
      }
    }
    // Cada enfoque gana con SU voto en las metas que más le importan.
    for (const a of P.BUILTIN_APPROACHES) {
      const r = P.deriveDesignRules(profileOf(a.id));
      for (const t of ['module.opening', 'objectives.style', 'content.type', 'video.style', 'activity.intent', 'assessment.strategy', 'feedback.mode']) {
        eq(r.targets[t], a.votes[t].value, `${a.id} ${t}`);
      }
    }
  });

  // ── T2 ───────────────────────────────────────────────────────────────────
  await check('T2 las reglas llegan al Blueprint (course.pedagogy + design en cada módulo y capítulo, por rol)', () => {
    for (const a of APPROACHES) {
      const rules = P.deriveDesignRules(profileOf(a));
      const s = P.applyPedagogyToSnapshot(plainSnapshot(), rules);
      eq(snap.validateBlueprintSnapshotV2(s), [], `${a}: valida`);
      eq(s.course.pedagogy.approaches.map((x) => x.id), [a], `${a}: enfoque`);
      eq(s.course.pedagogy.assessment.strategy, rules.targets['assessment.strategy'], `${a}: estrategia`);
      for (const m of s.modules) {
        eq(m.design, { opening: rules.targets['module.opening'], closing: rules.targets['module.closing'] }, `${a}: módulo`);
        m.chapters.forEach((c, i) => {
          const role = P.chapterRole(i, m.chapters.length);
          assert(!('role' in c.design), `${a}: el rol (posición) NO se congela por capítulo`);
          eq(c.design.sequence, rules.sequence, `${a}: secuencia`);
          eq(c.design.activity.intent, rules.targets['activity.intent'], `${a}: intención base`);
          eq(c.design.video.style, rules.targets['video.style'], `${a}: estilo de video`);
          const eff = P.effectiveChapterDesign(s, c.id);
          eq(eff.role, role, `${a}: rol efectivo por posición`);
          eq(eff.activity.intent, P.targetsForRole(rules, role)['activity.intent'], `${a}: intención efectiva por rol`);
        });
      }
      eq(s.course.pedagogy.roleTargets, JSON.parse(JSON.stringify(rules.roleTargets)), `${a}: variaciones por rol a nivel curso`);
    }
  });
  await check('Review I2 + Fase 2 (N2/I1): reordenar o agregar capítulos no cambia el diseño congelado ni la huella del contenido; solo cambia la huella del trabajo cuyo diseño efectivo cambió por el rol', () => {
    const rules = P.deriveDesignRules(profileOf('competencias')); // variación por rol: cierre del módulo → simular
    const build = (st) => P.applyPedagogyToSnapshot(P.snapshotFromStructure(st), rules);
    const s0 = build(RCP);
    const f0 = fp.computeFingerprintsV3(s0);
    const re = JSON.parse(JSON.stringify(RCP));
    re.modules[0].chapters.reverse();
    const s1 = build(re);
    const f1 = fp.computeFingerprintsV3(s1);
    const ids = s0.modules.flatMap((m) => m.chapters.map((c) => c.id));
    for (const id of ids) eq(f1.content.get(id).own, f0.content.get(id).own, `reorden: own de ${id}`);
    eq([f1.courseOutline, f1.finalExam], [f0.courseOutline, f0.finalExam], 'reorden: outline y final');
    const types = ['content', 'experience', 'presentation', 'video', 'video_interactions', 'activity', 'audiobook_chapter'];
    const changed = [];
    for (const id of ids) for (const t of types) {
      const key = `${t}:${id}`;
      const ex = t === 'activity' ? { variant: 'h5p' } : t === 'video_interactions' ? { videoIdentity: 'v' } : {};
      if (fp.itemFingerprintV3(f0, key, ex) !== fp.itemFingerprintV3(f1, key, ex)) changed.push(key);
    }
    const first = '8a0d1f00-0000-4000-8000-000000000011', last = '8a0d1f00-0000-4000-8000-000000000013';
    eq(changed.sort(), [`activity:${first}`, `activity:${last}`].sort(), 'reorden: solo las actividades del viejo y del nuevo cierre (simular ↔ aplicar)');
    const app = JSON.parse(JSON.stringify(RCP));
    app.modules[0].chapters.push({ id: '8a0d1f00-0000-4000-8000-000000000014', title: 'Capítulo agregado', objective: 'Aplicar lo anterior en un simulacro', videoEnabled: true, activityEnabled: true });
    const s2 = build(app);
    const f2 = fp.computeFingerprintsV3(s2);
    for (const id of ids) eq(f2.content.get(id).own, f0.content.get(id).own, `agregado: own de ${id}`);
    assert(fp.itemFingerprintV3(f2, `activity:${last}`, { variant: 'h5p' }) !== fp.itemFingerprintV3(f0, `activity:${last}`, { variant: 'h5p' }), 'el viejo cierre (ahora desarrollo) cambia de actividad');
    eq(fp.itemFingerprintV3(f2, `content:${last}`), fp.itemFingerprintV3(f0, `content:${last}`), 'pero su contenido no');
    eq([P.effectiveChapterDesign(s0, last).role, P.effectiveChapterDesign(s2, last).role], ['module_closing', 'core'], 'rol efectivo recalculado');
  });
  await check('Review I3: cambios del perfil que no tocan el diseño (descripción del estudiante, resultados, origen) no cambian ninguna huella', () => {
    const a = profileOf('significativo');
    const b = { ...a, learner: { ...a.learner, description: 'Otra descripción' }, learningOutcomes: { know: ['x'], do: [], competencies: [] }, origin: 'wizard' };
    const sa = P.applyPedagogyToSnapshot(plainSnapshot(), P.deriveDesignRules(a));
    const sb = P.applyPedagogyToSnapshot(plainSnapshot(), P.deriveDesignRules(b));
    assert(sa.course.pedagogy.profileSha256 !== sb.course.pedagogy.profileSha256, 'el perfil sí cambió');
    const fa = fp.computeFingerprintsV3(sa), fb = fp.computeFingerprintsV3(sb);
    eq([fb.courseOutline, fb.finalExam, [...fb.exam.values()], [...fb.content.values()].map((x) => x.full)], [fa.courseOutline, fa.finalExam, [...fa.exam.values()], [...fa.content.values()].map((x) => x.full)], 'huellas idénticas');
    const c = fp.computeFingerprintsV3(P.applyPedagogyToSnapshot(plainSnapshot(), P.deriveDesignRules({ ...a, principles: ['Seguridad primero'] })));
    assert(c.courseOutline !== fa.courseOutline, 'un principio nuevo SÍ cambia el diseño');
  });
  await check('Tope de escenarios ramificados con varios módulos (4×3): ≤ floor(n/4), primero en los cierres de módulo', () => {
    const big = JSON.parse(JSON.stringify(RCP));
    big.modules.push({ id: '8a0d1f00-0000-4000-8000-000000000004', title: 'Integración', objective: 'Aplicar la RCP completa', examEnabled: true,
      chapters: [1, 2, 3].map((i) => ({ id: `8a0d1f00-0000-4000-8000-00000000004${i}`, title: `Simulacro ${i}`, objective: `Aplicar la secuencia completa en el simulacro ${i}`, videoEnabled: true, activityEnabled: true })) });
    const dr = P.runPedagogyDryRun({ structure: big, profile: profileOf('competencias'), activityTypeRules: 2 });
    const bs = dr.chapters.filter((c) => c.activity.type === 'branchingscenario');
    eq(bs.length, 3, 'tope = floor(12/4)');
    assert(bs.every((c) => c.role === 'module_closing'), `BS en cierres: ${bs.map((c) => c.role)}`);
    eq(dr.pedagogical.manifestErrors, [], 'valida');
  });
  await check('T2 el diseño sobrevive al round-trip jsonb (claves reordenadas → recanonicalize → mismo sha) y un diseño incompleto falla fuerte', () => {
    const s = pedSnapshot('competencias+experiencial');
    const back = snap.recanonicalizeBlueprintSnapshotV2(shuffleKeys(JSON.parse(JSON.stringify(s))));
    eq(snap.snapshotSha256V2(back), snap.snapshotSha256V2(s), 'sha');
    const broken = JSON.parse(JSON.stringify(s));
    delete broken.modules[1].chapters[0].design;
    throwsRe(() => snap.recanonicalizeBlueprintSnapshotV2(broken), /BLUEPRINT_PEDAGOGY_INVALID/, 'capítulo sin design');
    assert(snap.validateBlueprintSnapshotV2(broken).some((e) => e.code === 'PEDAGOGY_INCOMPLETE'), 'validador');
    const orphan = JSON.parse(JSON.stringify(plainSnapshot()));
    orphan.modules[0].design = { opening: 'x', closing: 'y' };
    throwsRe(() => snap.recanonicalizeBlueprintSnapshotV2(orphan), /design sin course\.pedagogy/, 'design sin pedagogy');
  });

  // ── T3 ───────────────────────────────────────────────────────────────────
  await check('T3 las reglas llegan al Manifest: features.pedagogy, design por tipo de item, h5pType del diseño; valida con reglas 0/1/2', () => {
    for (const a of APPROACHES) {
      const s = pedSnapshot(a);
      const sha = snap.snapshotSha256V2(s);
      for (const r of [0, 1, 2]) {
        const m = mb.buildGenerationManifestV3(s, SOURCE(sha), { activityTypeRules: r });
        eq(mb.validateGenerationManifestV3(m, s, SOURCE(sha)), [], `${a} r${r}: valida`);
        eq(m.features.pedagogy, { engineVersion: 1, profileSha256: s.course.pedagogy.profileSha256 }, `${a}: features.pedagogy`);
        for (const it of m.items) {
          const noDesign = it.type === 'audio_welcome' || it.type === 'audiobook_chapter';
          assert(noDesign ? it.design === undefined : it.design !== undefined, `${a}: ${it.key} design`);
          if (it.type === 'activity') {
            assert(typeof it.h5pType === 'string', `${a}: ${it.key} sin h5pType`);
            if (r !== 2) assert(it.h5pType !== 'branchingscenario', `${a} r${r}: BS sin H5P v2`);
          }
        }
        const exam = m.items.find((i) => i.type === 'exam');
        eq(exam.design.strategy, s.course.pedagogy.assessment.strategy, `${a}: exam`);
        const video = m.items.find((i) => i.type === 'video');
        eq(video.design, { style: s.modules[0].chapters[0].design.video.style }, `${a}: video`);
      }
    }
  });
  await check('T3 el validador exige el diseño: design adulterado / faltante / sobrante, h5pType ajeno y features.pedagogy falsos se detectan', () => {
    const s = pedSnapshot('problemas');
    const sha = snap.snapshotSha256V2(s);
    const good = mb.buildGenerationManifestV3(s, SOURCE(sha), { activityTypeRules: 2 });
    const codes = (m, sn = s) => mb.validateGenerationManifestV3(m, sn, SOURCE(sha)).map((e) => e.code);
    const clone = () => JSON.parse(JSON.stringify(good));
    let m = clone(); m.items.find((i) => i.type === 'video').design.style = 'micro_lecture';
    assert(codes(m).includes('WRONG_DESIGN'), 'adulterado');
    m = clone(); delete m.items.find((i) => i.type === 'content').design;
    assert(codes(m).includes('MISSING_DESIGN'), 'faltante');
    m = clone(); m.items.find((i) => i.type === 'audio_welcome').design = { x: 1 };
    assert(codes(m).includes('UNEXPECTED_DESIGN'), 'sobrante');
    m = clone(); const act = m.items.find((i) => i.type === 'activity'); act.h5pType = act.h5pType === 'dragtext' ? 'blanks' : 'dragtext';
    assert(codes(m).includes('WRONG_H5P_TYPE'), 'h5pType');
    m = clone(); delete m.features.pedagogy;
    assert(codes(m).includes('FEATURES_MISMATCH'), 'features');
    // Manifest de siempre contra un Blueprint pedagógico (y al revés) → no valida.
    const plain = plainSnapshot();
    const legacy = mb.buildGenerationManifestV3(plain, SOURCE(sha), { activityTypeRules: 2 });
    assert(codes(legacy).includes('MISSING_DESIGN') && codes(legacy).includes('FEATURES_MISMATCH'), 'legacy vs pedagógico');
    assert(codes(good, plain).includes('UNEXPECTED_DESIGN'), 'pedagógico vs plano');
    // Canónico estable ante jsonb.
    eq(mb.manifestSha256(shuffleKeys(JSON.parse(JSON.stringify(good)))), mb.manifestSha256(good), 'sha estable');
  });

  // ── T4 ───────────────────────────────────────────────────────────────────
  await check('T4 cambiar el enfoque cambia el diseño (Blueprints, Manifests y filas del dry-run distintos)', () => {
    const shas = new Set(), msh = new Set(), rows = new Set();
    for (const a of APPROACHES) {
      const s = pedSnapshot(a);
      shas.add(snap.snapshotSha256V2(s));
      msh.add(mb.manifestSha256(mb.buildGenerationManifestV3(s, SOURCE('x'), { activityTypeRules: 2 })));
      const dr = P.runPedagogyDryRun({ structure: RCP, profile: profileOf(a) });
      rows.add(JSON.stringify(dr.chapters.map((c) => [c.sequence, c.contentType, c.video.style, c.activity.type, c.feedback])));
    }
    eq([shas.size, msh.size, rows.size], [5, 5, 5], 'todos distintos');
  });

  // ── T5 ───────────────────────────────────────────────────────────────────
  await check('T5 sin perfil: Blueprint, Manifest (reglas 0/1/2) y huellas byte-idénticos a origin/staging (pins)', () => {
    const s = plainSnapshot();
    const sha = snap.snapshotSha256V2(s);
    eq(sha, PINS.blueprintSha, 'blueprint');
    for (const r of [0, 1, 2]) {
      const m = mb.buildGenerationManifestV3(s, SOURCE(sha), { activityTypeRules: r });
      eq(mb.manifestSha256(m), PINS[`manifestSha_r${r}`], `manifest r${r}`);
      assert(!('pedagogy' in m.features) && m.items.every((i) => !('design' in i)), 'sin claves nuevas');
    }
    const f = fp.computeFingerprintsV3(s);
    eq([f.courseOutline, f.finalExam, f.content.get(s.modules[0].chapters[0].id).full], [PINS.fpCourseOutline, PINS.fpFinalExam, PINS.fpContentFull1], 'huellas');
  });

  // ── T6 ───────────────────────────────────────────────────────────────────
  await check('T6 perfil vacío (null, {}, sin enfoque) = comportamiento anterior: sin reglas, sin vista pedagógica, mismo Blueprint', () => {
    for (const empty of [null, undefined, {}, P.emptyPedagogicalProfile(), { ...profileOf('competencias'), primaryApproach: null, secondaryApproaches: [] }]) {
      assert(P.isEmptyPedagogicalProfile(empty), `vacío: ${JSON.stringify(empty)}`);
      eq(P.deriveDesignRulesOrNull(empty), null, 'sin reglas');
      const dr = P.runPedagogyDryRun({ structure: RCP, profile: empty });
      assert(dr.pedagogical === null && dr.profileEmpty === true && dr.rules === null, 'sin vista pedagógica');
      eq(dr.baseline.blueprintSha256, PINS.blueprintSha, 'mismo blueprint');
      eq(dr.structureChanges, [], 'sin cambios');
    }
    eq(snap.snapshotSha256V2(P.applyPedagogyToSnapshot(plainSnapshot(), null)), PINS.blueprintSha, 'applyPedagogy(null)');
    throwsRe(() => P.deriveDesignRules(null), /PEDAGOGY_PROFILE_EMPTY/, 'deriveDesignRules exige perfil');
  });

  // ── T7 ───────────────────────────────────────────────────────────────────
  const INTENT_TYPES = {
    apply: ['questionset', 'branchingscenario', 'dragtext'], decide: ['branchingscenario', 'questionset', 'blanks'],
    simulate: ['branchingscenario', 'questionset', 'dragtext'], relate: ['dragtext', 'blanks', 'questionset'], self_check: ['questionset', 'blanks'],
  };
  await check('T7 las actividades corresponden al enfoque (intención del diseño → tipo H5P coherente, tope de escenarios y variedad)', () => {
    const dominant = {
      competencias: ['questionset', 'branchingscenario'], problemas: ['branchingscenario', 'questionset'],
      experiencial: ['branchingscenario', 'questionset'], significativo: ['dragtext', 'blanks'], autodirigido: ['questionset', 'blanks'],
    };
    for (const a of APPROACHES) {
      const dr = P.runPedagogyDryRun({ structure: RCP, profile: profileOf(a), activityTypeRules: 2 });
      const types = dr.chapters.filter((c) => c.activity.enabled).map((c) => c.activity.type);
      for (const c of dr.chapters) assert(INTENT_TYPES[c.activity.intent].includes(c.activity.type), `${a}: ${c.title} ${c.activity.intent} → ${c.activity.type}`);
      const share = types.filter((t) => dominant[a].includes(t)).length / types.length;
      assert(share >= 0.6, `${a}: solo ${Math.round(share * 100)} % de actividades del tipo del enfoque (${types.join(',')})`);
      assert(types.filter((t) => t === 'branchingscenario').length <= Math.max(1, Math.floor(types.length / 4)), `${a}: tope BS`);
      const counts = {}; for (const t of types) counts[t] = (counts[t] || 0) + 1;
      assert(Math.max(...Object.values(counts)) <= Math.max(2, Math.ceil(0.6 * types.length)), `${a}: variedad ${JSON.stringify(counts)}`);
    }
    // Decisión ⇒ escenario ramificado (H5P v2); sin H5P v2 nunca aparece.
    const abp = P.runPedagogyDryRun({ structure: RCP, profile: profileOf('problemas'), activityTypeRules: 2 });
    assert(abp.chapters.some((c) => c.activity.type === 'branchingscenario'), 'ABP sin escenarios');
    const abp1 = P.runPedagogyDryRun({ structure: RCP, profile: profileOf('problemas'), activityTypeRules: 1 });
    assert(abp1.chapters.every((c) => c.activity.type !== 'branchingscenario'), 'BS con reglas 1');
  });

  // ── T8 ───────────────────────────────────────────────────────────────────
  await check('T8 la estrategia de evaluación corresponde al enfoque (examen de módulo, final, retroalimentación, pesos sugeridos)', () => {
    const want = {
      competencias: ['performance_evidence', 'situational_cases', 'integrative_performance_case', 'criterion_referenced'],
      problemas: ['solution_evaluation', 'problem_scenarios', 'integrative_problem', 'guided_hints'],
      experiencial: ['reflective_evidence', 'experience_based_cases', 'integrative_experience', 'reflective_prompts'],
      significativo: ['conceptual_understanding', 'conceptual_relations', 'integrative_concept_synthesis', 'elaborative_explanation'],
      autodirigido: ['self_assessment', 'self_check_bank', 'self_assessment_plus_test', 'self_check_keys'],
    };
    for (const a of APPROACHES) {
      const dr = P.runPedagogyDryRun({ structure: RCP, profile: profileOf(a) });
      eq([dr.assessment.strategy, dr.assessment.examStyle, dr.assessment.finalExamStyle, dr.assessment.feedbackMode], want[a], a);
      const m = dr.pedagogical.manifest;
      for (const e of m.items.filter((i) => i.type === 'exam')) eq(e.design.examStyle, want[a][1], `${a}: ${e.key}`);
      eq(m.items.find((i) => i.type === 'final_exam').design.finalExamStyle, want[a][2], `${a}: final`);
      const w = dr.assessment.suggestedWeights;
      eq(w.practice + w.moduleExams + w.finalExam, 100, `${a}: pesos suman 100`);
    }
    const comp = P.runPedagogyDryRun({ structure: RCP, profile: profileOf('competencias') }).assessment.suggestedWeights.practice;
    const sig = P.runPedagogyDryRun({ structure: RCP, profile: profileOf('significativo') }).assessment.suggestedWeights.practice;
    assert(comp > sig, `competencias (${comp}) debe pesar más la práctica que significativo (${sig})`);
  });

  // ── T9 ───────────────────────────────────────────────────────────────────
  await check('T9 videos y recursos cambian según el enfoque (estilo, cobertura, interacciones, repaso, recursos, costo estimado)', () => {
    const styles = new Set(), interactions = new Set(), resources = new Set();
    for (const a of APPROACHES) {
      const dr = P.runPedagogyDryRun({ structure: RCP, profile: profileOf(a) });
      styles.add(dr.chapters[0].video.style);
      interactions.add(dr.chapters[0].video.interactions);
      resources.add(JSON.stringify(dr.chapters[0].resources));
    }
    eq([styles.size, interactions.size, resources.size], [5, 5, 5], 'estilos/interacciones/recursos distintos');
    const abp = P.runPedagogyDryRun({ structure: RCP, profile: profileOf('problemas') });
    eq(abp.chapters.map((c) => c.video.enabled), [true, false, false, true, false, false, true, false, false], 'ABP: un video por módulo');
    eq(abp.diff.itemsRemoved.filter((k) => k.startsWith('video:')).length, 6, 'ABP: 6 videos menos');
    assert(Number(abp.diff.estimateExpectedUsd.pedagogical) < Number(abp.diff.estimateExpectedUsd.baseline), 'ABP: costo estimado menor');
    for (const a of ['significativo', 'autodirigido']) {
      const dr = P.runPedagogyDryRun({ structure: RCP, profile: profileOf(a) });
      assert(dr.structureChanges.some((c) => c.field === 'reviewCards' && c.to === true), `${a}: repaso`);
      assert(dr.pedagogical.blueprint.course.reviewCards === true, `${a}: reviewCards en el Blueprint propuesto`);
    }
    // Una estructura con videos apagados: competencias/experiencial los proponen en todos los capítulos.
    const novideo = JSON.parse(JSON.stringify(RCP));
    novideo.modules.forEach((m) => m.chapters.forEach((c) => { c.videoEnabled = false; }));
    const comp = P.runPedagogyDryRun({ structure: novideo, profile: profileOf('competencias') });
    eq(comp.structureChanges.filter((c) => c.field === 'videoEnabled' && c.to).length, 9, 'competencias: 9 videos propuestos');
    eq(comp.diff.itemsAdded.filter((k) => k.startsWith('video:')).length, 9, 'competencias: +9 items de video');
    const keep = P.runPedagogyDryRun({ structure: novideo, profile: profileOf('competencias'), applyStructureAdjustments: false });
    eq(keep.structureChanges, [], 'sin ajustes: no cambia toggles');
  });

  // ── T10 ──────────────────────────────────────────────────────────────────
  await check('T10 el dry-run nunca llama proveedores: proceso aislado con TODA la red bloqueada, 0 intentos, sin módulos de proveedor cargados', () => {
    const child = `
      const net = require('net'), dns = require('dns'), http = require('http'), https = require('https');
      let attempts = 0;
      const deny = (what) => function () { attempts++; throw new Error('RED BLOQUEADA: ' + what); };
      net.Socket.prototype.connect = deny('net.connect');
      net.connect = net.createConnection = deny('net.createConnection');
      dns.lookup = deny('dns.lookup'); dns.resolve = deny('dns.resolve');
      http.request = http.get = deny('http.request'); https.request = https.get = deny('https.request');
      globalThis.fetch = deny('fetch');
      const P = require(${JSON.stringify(path.join(distRoot, 'modules/pedagogy/index.js'))});
      const RCP = require(${JSON.stringify(path.join(FIX, 'rcp-course.json'))});
      const profile = { pedagogyProfileVersion: 1, primaryApproach: 'problemas', secondaryApproaches: ['experiencial'],
        learner: { description: null, ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' },
        learningOutcomes: { know: [], do: ['RCP'], competencies: [] }, learningModes: ['problems'], experienceTypes: ['challenges'],
        assessmentMethods: ['cases'], principles: [], origin: 'manual' };
      const r = P.runPedagogyDryRun({ structure: RCP, profile });
      const rec = P.recommendApproaches({ q3: ['practice'] });
      const loaded = Object.keys(require.cache).filter((f) => /[\\\\/](services|workers|provider-real|youtube|gamma|elevenlabs|openai|anthropic|axios|node-fetch)[\\\\/.]/i.test(f) && !/node_modules[\\\\/](typeorm|@nestjs)/.test(f));
      console.log(JSON.stringify({ attempts, loaded, providersCalled: r.providersCalled, spend: r.spendUsd, jobs: r.pedagogical.manifest.totals.totalJobs, errors: r.pedagogical.manifestErrors.length, rec: rec.ranking.length, est: r.pedagogical.providers.estimateUsd && r.pedagogical.providers.estimateUsd.expected }));
    `;
    const res = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    assert(res.status === 0, `exit ${res.status}: ${res.stderr}`);
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    eq(out.attempts, 0, 'intentos de red');
    eq(out.loaded, [], 'módulos de proveedor cargados');
    eq([out.providersCalled, out.spend, out.errors], [0, '0.00', 0], 'resultado');
    assert(out.jobs > 0 && out.rec === 5 && Number(out.est) > 0, 'el dry-run completó (con estimación de costo)');
  });
  await check('T10 el código del motor no importa clientes de proveedores ni de DB (salvo pedagogy-db / servicio / controller)', () => {
    const dir = path.join(REPO, 'src/modules/pedagogy');
    const pure = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !['pedagogy-db.ts', 'pedagogy.service.ts', 'pedagogy.controller.ts', 'pedagogy.module.ts', 'index.ts'].includes(f));
    for (const f of pure) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const i of imports) {
        assert(!/typeorm|@nestjs|services\/|workers\/|axios|fetch|provider|youtube|gamma|openai|anthropic|elevenlabs|pg$/.test(i), `${f} importa ${i}`);
      }
    }
  });

  // ── T11 ──────────────────────────────────────────────────────────────────
  await check('T11 «No estoy seguro»: las 6 preguntas exactas con sus opciones', () => {
    const q = P.WIZARD_QUESTIONS;
    eq(q.map((x) => x.id), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'], 'ids');
    eq(q.map((x) => x.title), [
      '¿Quiénes son los estudiantes?', '¿Qué quieres que logren al finalizar el curso?', '¿Cómo quieres que aprendan principalmente?',
      '¿Qué tipo de experiencia quieres que tenga el estudiante?', '¿Cómo quieres comprobar que aprendió?',
      '¿Hay alguna metodología, enfoque o principio pedagógico que quieras priorizar?',
    ], 'títulos');
    eq(q[2].options.map((o) => o.label), ['Comprendiendo conceptos y teorías', 'Resolviendo problemas o casos', 'Desarrollando proyectos', 'Practicando y experimentando', 'Investigando y descubriendo', 'Trabajando colaborativamente', 'Aplicando lo aprendido a situaciones reales', 'Combinación'], 'P3');
    eq(q[3].options.map((o) => o.label), ['Principalmente autónoma', 'Guiada por el docente', 'Basada en interacción y colaboración', 'Basada en práctica y experimentación', 'Basada en retos o problemas', 'Combinación'], 'P4');
    eq(q[4].options.map((o) => o.label), ['Pruebas o cuestionarios', 'Ejercicios prácticos', 'Casos o problemas', 'Proyectos', 'Productos o evidencias', 'Autoevaluación y reflexión', 'Evaluación entre compañeros', 'Combinación'], 'P5');
    eq(q[5].options.map((o) => o.label), ['Sí', 'No', 'No estoy seguro'], 'P6');
    // Textos de ayuda = los del pedido del usuario (directiva 2026-10-04, Fase 6).
    eq(q[0].help, 'Edad, nivel educativo, perfil, conocimientos previos y experiencia.', 'P1 ayuda');
    eq(q[1].help, 'Qué deben saber, saber hacer y qué competencias deben desarrollar.', 'P2 ayuda');
    eq(q[0].fields.map((f) => f.id), ['description', 'ageGroup', 'educationLevel', 'priorKnowledge', 'experience'], 'P1 campos (edad, nivel, perfil, conocimientos previos, experiencia)');
    eq(q[1].fields.map((f) => [f.id, f.label]), [['know', 'Qué deben saber'], ['do', 'Qué deben saber hacer'], ['competencies', 'Qué competencias deben desarrollar']], 'P2 campos');
  });
  await check('T11 recomendación válida para cada fixture (ranking de 5 ordenado, %, razones, perfil sugerido válido que deriva reglas)', () => {
    const top = { 'rcp-practico': 'competencias', 'casos-retos': 'problemas', 'conceptos-novatos': 'significativo', 'autonomos-expertos': 'autodirigido', 'prioriza-experiencial': 'experiencial' };
    for (const [k, ans] of Object.entries(PF.wizardAnswers)) {
      const rec = P.recommendApproaches(ans);
      eq(rec.ranking.length, 5, `${k}: 5 enfoques`);
      // Orden: primero lo priorizado en P6, luego por puntaje.
      for (let i = 1; i < rec.ranking.length; i++) {
        const [x, y] = [rec.ranking[i - 1], rec.ranking[i]];
        assert(Number(x.prioritized) > Number(y.prioritized) || (x.prioritized === y.prioritized && x.score >= y.score), `${k}: orden`);
      }
      for (const r of rec.ranking) assert(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100 && r.reasons.length >= 1 && r.label, `${k}: fila ${r.approach}`);
      eq(P.validatePedagogicalProfile(rec.suggestedProfile), [], `${k}: perfil sugerido válido`);
      assert(P.deriveDesignRules(rec.suggestedProfile).sequence.length > 0, `${k}: deriva reglas`);
      eq(rec.suggestedProfile.origin, 'wizard', `${k}: origin`);
      if (top[k]) eq(rec.ranking[0].approach, top[k], `${k}: primero`);
    }
    // Etiquetas de P1 por campo (los ids «basic»/«none» se repiten entre campos).
    const nov = P.recommendApproaches({ q1: { priorKnowledge: 'basic', experience: 'none', educationLevel: 'basic' } });
    const q1Reasons = nov.ranking.flatMap((r) => r.reasons).filter((x) => x.question === 'q1').map((x) => x.text);
    assert(q1Reasons.every((t) => !/básica/.test(t)) && q1Reasons.some((t) => /Conocimientos previos: básicos|Experiencia práctica: ninguna/.test(t)), `razones P1: ${q1Reasons.join(' | ')}`);
    const empty = P.recommendApproaches({});
    eq([empty.confidence, empty.answered], ['baja', 0], 'vacío: confianza baja');
    assert(empty.notes.length > 0, 'vacío: nota');
    const pr = P.recommendApproaches(PF.wizardAnswers['prioriza-experiencial']);
    assert(pr.ranking[0].reasons.some((r) => r.question === 'q6'), 'P6 aparece como razón');
    // Sin la prioridad, las mismas respuestas (conceptos, guiada, pruebas) apuntan a otro enfoque.
    const noPr = P.recommendApproaches({ ...PF.wizardAnswers['prioriza-experiencial'], q6: { answer: 'no' } });
    assert(noPr.ranking[0].approach !== 'experiencial', 'la prioridad explícita es lo que lo sube');
    eq(pr.suggestedProfile.principles, ['Aprender haciendo con simulación'], 'principio de P6 en el perfil');
  });
  await check('T11 respuestas inválidas fallan fuerte (opción desconocida, enfoque desconocido, prioridad sin «Sí»)', () => {
    throwsRe(() => P.recommendApproaches({ q3: ['magia'] }), /WIZARD_INVALID.*INVALID_OPTION/, 'opción');
    throwsRe(() => P.recommendApproaches({ q6: { answer: 'yes', approaches: ['conductismo'] } }), /UNKNOWN_APPROACH/, 'enfoque');
    throwsRe(() => P.recommendApproaches({ q6: { answer: 'no', approaches: ['problemas'] } }), /PRIORITY_WITHOUT_YES/, 'sin sí');
    throwsRe(() => P.recommendApproaches({ q7: [] }), /UNKNOWN_FIELD/, 'pregunta desconocida');
    throwsRe(() => P.recommendApproaches({ q1: 'adultos' }), /INVALID_TYPE q1/, 'q1 sin objeto (review M2)');
    throwsRe(() => P.recommendApproaches({ q2: [1] }), /INVALID_TYPE q2/, 'q2 array');
    throwsRe(() => P.recommendApproaches({ q6: { answer: 'yes', approaches: 'experiencial' } }), /INVALID_TYPE q6\.approaches/, 'q6.approaches texto');
  });
  await check('Review M3: los enfoques priorizados en P6 siempre quedan en el perfil sugerido', () => {
    const r = P.recommendApproaches({ q3: ['concepts'], q4: ['teacher_guided'], q5: ['quizzes'], q6: { answer: 'yes', approaches: ['autodirigido', 'problemas'] } });
    const chosen = [r.suggestedProfile.primaryApproach, ...r.suggestedProfile.secondaryApproaches];
    assert(chosen.includes('autodirigido') && chosen.includes('problemas'), `priorizados incluidos: ${chosen}`);
    assert(['autodirigido', 'problemas'].includes(r.suggestedProfile.primaryApproach), 'principal priorizado');
  });

  // ── T12 ──────────────────────────────────────────────────────────────────
  await check('T12 combinar enfoques: pesos 0,6/0,4, secuencia con los pasos firma del secundario, metas que gana el secundario, Manifest válido', () => {
    const r = P.deriveDesignRules(profileOf('competencias+experiencial'));
    eq(r.approaches, [{ id: 'competencias', role: 'primary', weight: 0.6 }, { id: 'experiencial', role: 'secondary', weight: 0.4 }], 'pesos');
    assert(r.sequence.includes('reflective_observation') && r.sequence.includes('transfer'), 'pasos de experiencial');
    eq(r.sequence[0], 'competency_objectives', 'arranca con competencias');
    const r3 = P.deriveDesignRules(profileOf('problemas+significativo+autodirigido'));
    eq(r3.approaches.map((a) => a.weight), [0.6, 0.2, 0.2], 'pesos ×3');
    eq(r3.sequence.slice(0, 3), ['activate_prior_knowledge', 'learning_goals', 'driving_problem'], 'inicio combinado');
    assert(r3.sequence.includes('concept_map_synthesis') && r3.sequence.includes('self_assessment'), 'cierre combinado');
    eq(r3.targets['reviewCards.policy'], 'enable', 'meta ganada por los secundarios');
    assert(r3.applied.some((a) => a.outcome === 'overridden'), 'traza de votos perdidos');
    const single = P.deriveDesignRules(profileOf('competencias'));
    assert(JSON.stringify(single) !== JSON.stringify(r), 'la combinación cambia las reglas');
    const dr = P.runPedagogyDryRun({ structure: RCP, profile: profileOf('problemas+significativo+autodirigido') });
    eq(dr.pedagogical.manifestErrors, [], 'Manifest válido');
    eq(dr.pedagogical.blueprint.course.pedagogy.approaches.map((a) => a.id), ['problemas', 'significativo', 'autodirigido'], 'enfoques en el Blueprint');
  });

  // ── T13 ──────────────────────────────────────────────────────────────────
  await check('T13 un enfoque nuevo (solo datos) funciona en reglas, Blueprint, Manifest, dry-run y recomendación sin tocar el motor', () => {
    const flipped = {
      ...JSON.parse(JSON.stringify(P.APPROACH_SIGNIFICATIVO)),
      id: 'aula_invertida', label: 'Aula invertida', shortLabel: 'Invertida',
      summary: 'El estudiante estudia el contenido antes y el tiempo del curso se usa para practicar.',
      sequence: ['learning_goals', 'modular_content', 'self_assessment', 'guided_practice', 'application', 'reflection_plan'],
      signatureSteps: [{ step: 'modular_content', at: 'start' }],
      objectiveVerbs: ['preparar', 'aplicar'],
    };
    flipped.votes = { ...flipped.votes, 'activity.intent': { value: 'apply', weight: 0.9, ruleId: 'inv.activity.apply', rationale: 'Práctica aplicada.' } };
    flipped.affinity = { ...flipped.affinity, experienceTypes: { autonomous: 1, practice_experimentation: 1 } };
    const reg = P.defaultApproachRegistry().with(flipped);
    eq(P.defaultApproachRegistry().ids().length, 5, 'el registro por defecto no cambió');
    const profile = { ...profileOf('competencias'), primaryApproach: 'aula_invertida', secondaryApproaches: ['problemas'] };
    eq(P.validatePedagogicalProfile(profile), [{ path: 'primaryApproach', code: 'UNKNOWN_APPROACH', message: P.validatePedagogicalProfile(profile)[0].message }], 'el registro por defecto lo rechaza');
    const rules = P.deriveDesignRules(profile, reg);
    eq(rules.sequence, ['driving_problem', ...flipped.sequence, 'solution_evaluation'], 'secuencia propia + pasos firma del secundario');
    const dr = P.runPedagogyDryRun({ structure: RCP, profile, registry: reg });
    eq(dr.pedagogical.manifestErrors, [], 'Manifest válido');
    eq(dr.pedagogical.blueprint.course.pedagogy.approaches[0].id, 'aula_invertida', 'en el Blueprint');
    const rec = P.recommendApproaches({ q4: ['autonomous', 'practice_experimentation'] }, reg);
    assert(rec.ranking.some((r) => r.approach === 'aula_invertida'), 'en la recomendación');
    // Un enfoque mal escrito nunca entra.
    throwsRe(() => P.defaultApproachRegistry().with({ ...flipped, id: 'malo_x', votes: { 'video.style': { value: 'tiktok', weight: 1, ruleId: 'x', rationale: 'x' } } }), /APPROACH_INVALID/, 'valor fuera del vocabulario');
  });
  await check('T13 el motor no conoce enfoques por nombre (ningún id de enfoque en design-rules / pedagogical-blueprint / manifest-design / recommendation / dry-run)', () => {
    for (const f of ['design-rules.ts', 'pedagogical-blueprint.ts', 'manifest-design.ts', 'recommendation.ts', 'dry-run.ts', 'vocabulary.ts', 'approach-registry.ts']) {
      const src = fs.readFileSync(path.join(REPO, 'src/modules/pedagogy', f), 'utf8');
      for (const id of APPROACHES) assert(!new RegExp(`['"\`]${id}['"\`]`).test(src), `${f} menciona '${id}'`);
    }
  });

  // ── Extras ───────────────────────────────────────────────────────────────
  await check('Extra: todas las etiquetas en español existen (UI y reporte)', () => {
    eq(P.missingPedagogyLabels(), [], 'faltan etiquetas');
  });
  await check('Extra: revisión de objetivos (verbo no observable → sugerencia con el verbo del enfoque; objetivo faltante)', () => {
    const rules = P.deriveDesignRules(profileOf('competencias'));
    const lint = P.lintObjectives(pedSnapshot('competencias'), rules);
    const bad = lint.filter((l) => !l.ok);
    eq(bad.map((l) => l.verb), ['comprender', 'conocer', 'entender'], 'verbos marcados');
    eq(bad[1].suggestion, 'Aplicar los eslabones de la cadena de supervivencia intrahospitalaria y el papel del auxiliar en cada uno.', 'sugerencia');
    const s2 = JSON.parse(JSON.stringify(RCP));
    s2.modules[0].chapters[0].objective = null;
    const l2 = P.lintObjectives(P.applyPedagogyToSnapshot(P.snapshotFromStructure(s2), rules), rules);
    assert(l2.some((l) => l.issue === 'missing_objective'), 'objetivo faltante');
  });
  await check('Extra: huellas de invalidación: con diseño cambian (y por enfoque); sin diseño no (ver T5)', () => {
    const plain = fp.computeFingerprintsV3(plainSnapshot());
    const a = fp.computeFingerprintsV3(pedSnapshot('competencias'));
    const b = fp.computeFingerprintsV3(pedSnapshot('problemas'));
    const ch = plainSnapshot().modules[0].chapters[0].id;
    assert(a.content.get(ch).own !== plain.content.get(ch).own, 'content own cambia con diseño');
    assert(a.content.get(ch).own !== b.content.get(ch).own, 'content own cambia por enfoque');
    assert(a.finalExam !== plain.finalExam && a.courseOutline !== plain.courseOutline, 'final/outline cambian');
  });
  await check('Extra: dry-run: estructura inválida → DRY_RUN_INVALID_STRUCTURE; activityTypeRules inválido → DRY_RUN_INVALID', () => {
    throwsRe(() => P.runPedagogyDryRun({ structure: { course: { title: 'x' }, modules: [] }, profile: null }), /DRY_RUN_INVALID_STRUCTURE/, 'sin módulos');
    throwsRe(() => P.runPedagogyDryRun({ structure: { course: { title: 'x' }, modules: [{ title: 'M', chapters: [] }] }, profile: null }), /DRY_RUN_INVALID_STRUCTURE/, 'módulo vacío');
    throwsRe(() => P.runPedagogyDryRun({ structure: RCP, profile: null, activityTypeRules: 7 }), /DRY_RUN_INVALID/, 'reglas');
    throwsRe(() => P.runPedagogyDryRun({ structure: RCP, profile: { ...profileOf('competencias'), primaryApproach: 'x' } }), /PROFILE_INVALID/, 'perfil');
    // Review M1: formas rotas → 400 (código), nunca TypeError.
    throwsRe(() => P.runPedagogyDryRun({ structure: { course: { title: 'x' }, modules: [null] }, profile: null }), /DRY_RUN_INVALID_STRUCTURE/, 'módulo null');
    throwsRe(() => P.runPedagogyDryRun({ structure: { course: { title: 'x' }, modules: [{ title: 'M', chapters: [null] }] }, profile: null }), /DRY_RUN_INVALID_STRUCTURE/, 'capítulo null');
    throwsRe(() => P.runPedagogyDryRun({ structure: { course: { title: 'x' }, modules: [{ title: 'M', chapters: 5 }] }, profile: null }), /DRY_RUN_INVALID_STRUCTURE/, 'chapters no array');
    throwsRe(() => P.runPedagogyDryRun({ structure: { course: { title: 'x' }, modules: [{ id: 7, title: 'M', chapters: [{ title: 'c' }] }] }, profile: null }), /DRY_RUN_INVALID_STRUCTURE/, 'id de módulo no texto (re-review N1)');
    throwsRe(() => P.runPedagogyDryRun({ structure: { course: { title: 'x' }, modules: [{ title: 'M', chapters: [{ id: {}, title: 'c' }] }] }, profile: null }), /DRY_RUN_INVALID_STRUCTURE/, 'id de capítulo no texto');
    throwsRe(() => P.runPedagogyDryRun({ structure: { schemaVersion: 2, course: { id: 1, title: 'x', finalExam: true, activityEngine: 'h5p' } }, profile: null }), /DRY_RUN_INVALID_STRUCTURE/, 'snapshot sin modules');
    throwsRe(() => P.runPedagogyDryRun({ structure: { schemaVersion: 2, course: { id: 1, title: 'x', finalExam: true, activityEngine: 'h5p' }, modules: [{ id: 'a', position: 0, title: 'M', chapters: 5 }] }, profile: null }), /DRY_RUN_INVALID_STRUCTURE/, 'snapshot chapters no array');
  });
  await check('Extra: el dry-run de un snapshot vivo ignora un diseño ya congelado y recalcula desde el perfil pedido', () => {
    const frozen = pedSnapshot('autodirigido');
    const dr = P.runPedagogyDryRun({ structure: frozen, profile: profileOf('competencias') });
    eq(dr.baseline.blueprintSha256, PINS.blueprintSha, 'línea base sin diseño');
    eq(dr.pedagogical.blueprint.course.pedagogy.approaches[0].id, 'competencias', 'diseño nuevo');
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Parte DB: Postgres 16 desechable
// ════════════════════════════════════════════════════════════════════════════
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
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => (port === 5570 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

async function dbChecks() {
  console.log('\nParte DB');
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException, Logger } = require('@nestjs/common');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { PedagogyService } = loadDist('modules/pedagogy/pedagogy.service.js');
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-pedagogy-pg16-'));
  const ROLE = 'postgres.pedlocaltest01';
  const DB = 'peddb';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = { flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS, rules: process.env.DYNAMIC_MANIFEST_RULES_VERSION, atr: process.env.DYNAMIC_ACTIVITY_TYPE_RULES, unowned: process.env.ALLOW_UNOWNED_COURSES };
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`  Postgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', async (c) => {
      await c.query(`create database ${DB}`);
      await c.query(`create role "${ROLE}" superuser login`);
    });
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    const MIGRATE = path.join(REPO, 'scripts/migrate-pedagogy-profiles.js');
    const VERIFY = path.join(REPO, 'scripts/verify-pedagogy-profiles-schema.js');
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-pedagogy-cwd-'));
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [script], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    const kindDef = () => withClient(DB, async (c) => (await c.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname='course_profiles_kind_check'`)).rows[0].d);

    const OWNER = '11111111-2222-4333-8444-555555555555';
    const OTHER = '99999999-8888-4777-8666-555555555555';
    const course = await withClient(DB, async (c) => {
      const co = (await c.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, $2, 'dynamic', true, 'h5p') returning id`, [OWNER, RCP.course.title])).rows[0];
      const legacy = (await c.query(`insert into public.courses (owner_id, title) values ($1, 'Curso legacy') returning id`, [OWNER])).rows[0];
      for (const [mi, m] of RCP.modules.entries()) {
        const mm = (await c.query(`insert into public.course_modules (course_id, position, title, objective, exam_enabled) values ($1, $2, $3, $4, true) returning id`, [co.id, mi, m.title, m.objective])).rows[0];
        for (const [ci, ch] of m.chapters.entries()) {
          await c.query(`insert into public.course_chapters (course_id, module_id, position, title, objective, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, true, true)`, [co.id, mm.id, ci, ch.title, ch.objective]);
        }
      }
      return { id: co.id, legacyId: legacy.id };
    });

    await check('DB guard: sin MIGRATION_ENV=staging → exit ≠ 0 y el CHECK no cambia; ref de PRODUCCIÓN → exit ≠ 0', async () => {
      let res = runScript(MIGRATE, localEnv({}));
      assert(res.code !== 0 && /MIGRATION_ENV no es "staging"/.test(res.out), res.out);
      res = runScript(MIGRATE, localEnv({ MIGRATION_ENV: 'staging', DB_USER: 'postgres.hriwbakbuypaiovvvkqh' }));
      assert(res.code !== 0 && /PRODUCCIÓN/.test(res.out), res.out);
      res = runScript(VERIFY, localEnv({ MIGRATION_ENV: 'staging', DB_USER: 'postgres.hriwbakbuypaiovvvkqh' }));
      assert(res.code !== 0 && /PRODUCCIÓN/.test(res.out), res.out);
      assert(!(await kindDef()).includes('pedagogy'), 'aplicó igual');
    });
    await check('DB: antes de migrar, kind=pedagogy lo rechaza el CHECK y el verificador falla', async () => {
      await rejectsRe(withClient(DB, (c) => c.query(`insert into public.course_profiles (course_id, kind, version, data, sha256) values ($1, 'pedagogy', 1, '{}', $2)`, [course.id, '0'.repeat(64)])), /course_profiles_kind_check/, 'CHECK');
      const v = runScript(VERIFY, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(v.code !== 0 && /no admite 'pedagogy'/.test(v.out), v.out);
    });
    await check('DB: migración real dos veces (idempotente) + verificador verde (sonda revertida, no deja filas)', async () => {
      for (let i = 0; i < 2; i++) {
        const res = runScript(MIGRATE, localEnv({ MIGRATION_ENV: 'staging' }));
        assert(res.code === 0, `corrida ${i + 1}: ${res.out}`);
      }
      const v = runScript(VERIFY, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(v.code === 0 && /admite 'pedagogy'/.test(v.out), v.out);
      const n = await withClient(DB, async (c) => (await c.query(`select count(*)::int n from public.course_profiles`)).rows[0].n);
      eq(n, 0, 'la sonda no dejó filas');
      assert(/'presentation'.*'assessment'.*'pedagogy'/.test(await kindDef()), 'CHECK ampliado');
    });
    await check('DB: deploy-staging.yml corre la migración + verificación; setup-schema del E2E la incluye', () => {
      const yml = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-staging.yml'), 'utf8');
      assert(yml.includes('MIGRATION_ENV=staging node scripts/migrate-pedagogy-profiles.js') && yml.includes('MIGRATION_ENV=staging node scripts/verify-pedagogy-profiles-schema.js'), 'deploy-staging');
      assert(yml.indexOf('migrate-v21-blueprint-profiles.js') < yml.indexOf('migrate-pedagogy-profiles.js'), 'después de R3');
      const prod = fs.readFileSync(path.join(REPO, '.github/workflows/deploy.yml'), 'utf8');
      assert(!prod.includes('pedagogy'), 'deploy.yml (producción) no se toca');
      assert(fs.readFileSync(path.join(REPO, 'test/e2e-v2/setup-schema.js'), 'utf8').includes("'supabase-migration-pedagogy-profiles.sql'"), 'setup-schema');
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
    const structureSvc = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const liveMatches = async () => (await structureSvc.getStructure(course.id, OWNER)).liveMatchesCurrentBlueprint;
    const counter = async () => (await ds.query(`select structure_version_counter c from public.courses where id = $1`, [course.id]))[0].c;

    let plainSha = null;
    await check('DB lock v2 SIN perfil pedagógico: snapshot sin claves nuevas (comportamiento de siempre)', async () => {
      const res = await blueprints.lock(course.id, OWNER, await counter());
      eq([res.created, res.blueprint.schemaVersion], [true, 2], 'v2');
      assert(!('pedagogy' in res.blueprint.snapshot.course), 'sin course.pedagogy');
      assert(res.blueprint.snapshot.modules.every((m) => !('design' in m) && m.chapters.every((c) => !('design' in c))), 'sin design');
      plainSha = res.blueprint.sha256;
    });
    await check('DB perfiles: GET pedagogy sin guardar → vacío (isDefault, designRules null)', async () => {
      const g = await profiles.getCurrent(course.id, OWNER, 'pedagogy');
      eq([g.version, g.isDefault, g.profile.primaryApproach, g.designRules], [0, true, null, null], 'default vacío');
    });
    await check('DB perfiles: POST pedagogy válido → v1 con las reglas del SERVIDOR guardadas; idéntico → 200 sin versión nueva; inválido → 400; ajeno → 404', async () => {
      const p = profileOf('competencias');
      const a = await profiles.append(course.id, OWNER, 'pedagogy', { ...p, designRules: { fake: true } }, 0);
      eq([a.created, a.profile.version], [true, 1], 'creado');
      eq(a.profile.designRules.engineVersion, 1, 'reglas en la respuesta');
      eq(a.profile.rulesStale, false, 'no stale');
      const stored = (await ds.query(`select data from public.course_profiles where course_id=$1 and kind='pedagogy'`, [course.id]))[0].data;
      assert(stored.designRules && !stored.designRules.fake && stored.designRules.targets['assessment.strategy'] === 'performance_evidence', 'reglas del servidor guardadas');
      const again = await profiles.append(course.id, OWNER, 'pedagogy', p);
      eq([again.created, again.profile.version], [false, 1], 'idempotente');
      await rejectsRe(profiles.append(course.id, OWNER, 'pedagogy', { ...p, primaryApproach: 'conductismo' }), /UNKNOWN_APPROACH/, 'inválido', 400);
      await rejectsRe(profiles.append(course.id, OTHER, 'pedagogy', p), /not found/, 'ajeno', 404);
      await rejectsRe(profiles.append(course.id, OWNER, 'pedagogy', p, 0), /cambió/, 'expectedVersion viejo', 409);
      await rejectsRe(profiles.getCurrent(course.id, OWNER, 'tema'), /presentation, assessment, pedagogy/, 'kind desconocido', 400);
    });
    let pedNumber = null;
    await check('DB lock v2 CON perfil: congela course.pedagogy + design; valida; Manifest v3 desde lo guardado valida; re-lock idempotente', async () => {
      const res = await blueprints.lock(course.id, OWNER, await counter());
      eq(res.created, true, 'Blueprint nuevo (el diseño cambió)');
      const s = res.blueprint.snapshot;
      eq(s.course.pedagogy.approaches.map((x) => x.id), ['competencias'], 'enfoque congelado');
      eq(snap.validateBlueprintSnapshotV2(s), [], 'valida');
      assert(res.blueprint.sha256 !== plainSha, 'sha distinto');
      eq(s.modules[0].chapters.map((c) => P.effectiveChapterDesign(s, c.id).role), ['module_opening', 'core', 'module_closing'], 'roles efectivos (por posición)');
      pedNumber = res.blueprint.blueprintNumber;
      const read = await blueprints.getByNumberAnySchema(course.id, OWNER, pedNumber);
      eq(snap.snapshotSha256V2(read.snapshot), res.blueprint.sha256, 'round trip jsonb');
      const source = { courseId: course.id, blueprintId: read.id, blueprintNumber: pedNumber, blueprintSha256: read.sha256 };
      const m = mb.buildGenerationManifestV3(read.snapshot, source, { activityTypeRules: 2 });
      eq(mb.validateGenerationManifestV3(m, read.snapshot, source), [], 'Manifest v3 válido');
      assert(m.features.pedagogy && m.items.filter((i) => i.design).length > 50, 'Manifest con diseño');
      const again = await blueprints.lock(course.id, OWNER, await counter());
      eq(again.created, false, 'idempotente');
    });
    await check('Review I1: con perfil, la estructura confirmada SÍ coincide (liveMatches true); guardar otro perfil la marca desactualizada; re-confirmar vuelve a true', async () => {
      eq(await liveMatches(), true, 'después del lock con perfil');
      await profiles.append(course.id, OWNER, 'pedagogy', { ...profileOf('competencias'), learningModes: ['practice'] });
      eq(await liveMatches(), false, 'perfil nuevo → hay que re-confirmar');
      const res = await blueprints.lock(course.id, OWNER, await counter());
      eq(res.created, true, 'Blueprint nuevo');
      eq(await liveMatches(), true, 're-confirmado');
    });
    await check('DB lock v2: el lock NO aplica las sugerencias de estructura (los toggles son del docente)', async () => {
      await profiles.append(course.id, OWNER, 'pedagogy', profileOf('problemas'));
      const res = await blueprints.lock(course.id, OWNER, await counter());
      eq(res.blueprint.snapshot.modules.flatMap((m) => m.chapters.map((c) => c.videoEnabled)), Array(9).fill(true), 'videos intactos');
      eq(res.blueprint.snapshot.course.pedagogy.approaches[0].id, 'problemas', 'enfoque nuevo congelado');
    });
    await check('DB perfil vacío guardado (sin enfoque) → el siguiente lock vuelve al snapshot de siempre (mismo sha que sin perfil)', async () => {
      await profiles.append(course.id, OWNER, 'pedagogy', P.emptyPedagogicalProfile());
      const res = await blueprints.lock(course.id, OWNER, await counter());
      eq(res.blueprint.sha256, plainSha, 'mismo sha que sin perfil');
      assert(!('pedagogy' in res.blueprint.snapshot.course), 'sin diseño');
    });
    await check('DB motor de carga horaria: targetHours en el perfil (sin enfoque) → hay que reconfirmar; el lock lo congela; Manifest con los mismos trabajos; quitarlo vuelve al sha de siempre', async () => {
      eq(await liveMatches(), true, 'confirmado sin objetivo');
      const a = await profiles.append(course.id, OWNER, 'pedagogy', { ...P.emptyPedagogicalProfile(), targetHours: 33 });
      eq([a.created, a.profile.profile ? a.profile.profile.targetHours : a.profile.targetHours], [true, 33], 'perfil con 33 h guardado');
      eq(await liveMatches(), false, 'el objetivo nuevo pide reconfirmar');
      const res = await blueprints.lock(course.id, OWNER, await counter());
      eq([res.created, res.blueprint.snapshot.course.targetHours], [true, 33], 'Blueprint con targetHours');
      assert(!('pedagogy' in res.blueprint.snapshot.course), 'sin enfoque no hay diseño');
      eq(snap.validateBlueprintSnapshotV2(res.blueprint.snapshot), [], 'valida');
      eq(await liveMatches(), true, 'reconfirmado');
      const read = await blueprints.getByNumberAnySchema(course.id, OWNER, res.blueprint.blueprintNumber);
      eq(snap.snapshotSha256V2(read.snapshot), res.blueprint.sha256, 'round trip jsonb');
      const m = mb.buildGenerationManifestV3(read.snapshot, { courseId: course.id, blueprintId: read.id, blueprintNumber: read.blueprintNumber, blueprintSha256: read.sha256 }, { activityTypeRules: 2 });
      eq(mb.validateGenerationManifestV3(m, read.snapshot, m.source), [], 'Manifest v3 válido');
      const plainSnap = snap.recanonicalizeBlueprintSnapshotV2({ ...read.snapshot, course: { ...read.snapshot.course, targetHours: undefined } });
      const mPlain = mb.buildGenerationManifestV3(plainSnap, { ...m.source, blueprintSha256: snap.snapshotSha256V2(plainSnap) }, { activityTypeRules: 2 });
      eq(snap.snapshotSha256V2(plainSnap), plainSha, 'sin el objetivo es el Blueprint de siempre');
      eq([m.items, m.totals, m.features], [mPlain.items, mPlain.totals, mPlain.features], 'mismos trabajos');
      const dr = await pedagogy.dryRunCourse(course.id, OWNER, {});
      eq([dr.profileSource, dr.targetHours, dr.workload && dr.workload.targetHours, dr.pedagogical], ['saved', 33, 33, null], 'dry-run con el objetivo guardado');
      await rejectsRe(profiles.append(course.id, OWNER, 'pedagogy', { ...P.emptyPedagogicalProfile(), targetHours: 0.25 }), /INVALID_TARGET_HOURS/, 'objetivo inválido', 400);
      await profiles.append(course.id, OWNER, 'pedagogy', P.emptyPedagogicalProfile());
      eq(await liveMatches(), false, 'quitar el objetivo también pide reconfirmar');
      const back = await blueprints.lock(course.id, OWNER, await counter());
      eq(back.blueprint.sha256, plainSha, 'sin objetivo: el sha de siempre');
    });
    await check('DB dry-run del curso: estructura viva + perfil del cuerpo (sin guardar) o el guardado; solo lectura; ajeno 404; legacy 400', async () => {
      const before = await ds.query(`select (select count(*)::int from public.course_blueprints) b, (select count(*)::int from public.course_profiles) p, (select structure_version_counter from public.courses where id=$1) c`, [course.id]);
      const preview = await pedagogy.dryRunCourse(course.id, OWNER, { profile: profileOf('experiencial') });
      eq([preview.profileSource, preview.dryRun, preview.providersCalled, preview.spendUsd], ['request', true, 0, '0.00'], 'vista previa');
      eq(preview.pedagogical.manifestErrors, [], 'Manifest válido');
      eq(preview.activityTypeRules, 2, 'reglas de actividad de la config');
      const savedRun = await pedagogy.dryRunCourse(course.id, OWNER, {});
      eq([savedRun.profileSource, savedRun.pedagogical], ['saved', null], 'perfil guardado vacío → solo línea base');
      const after = await ds.query(`select (select count(*)::int from public.course_blueprints) b, (select count(*)::int from public.course_profiles) p, (select structure_version_counter from public.courses where id=$1) c`, [course.id]);
      eq(after, before, 'no escribió nada');
      await rejectsRe(pedagogy.dryRunCourse(course.id, OTHER, {}), /not found/, 'ajeno', 404);
      await rejectsRe(pedagogy.dryRunCourse(course.legacyId, OWNER, {}), /solo admite cursos "dynamic"/, 'legacy', 400);
      await rejectsRe(pedagogy.dryRunCourse(course.id, OWNER, { profile: { primaryApproach: 'x' } }), /PROFILE_INVALID/, 'perfil inválido', 400);
    });
    await check('DB servicio: catálogo, preguntas y recomendación (400 con respuestas inválidas); dry-run en línea con límites', async () => {
      const cat = pedagogy.catalog();
      eq(cat.approaches.map((a) => a.id), APPROACHES, 'catálogo');
      eq(pedagogy.wizard().questions.length, 6, '6 preguntas');
      eq(pedagogy.recommend(PF.wizardAnswers['casos-retos']).ranking[0].approach, 'problemas', 'recomendación');
      await rejectsRe(Promise.resolve().then(() => pedagogy.recommend({ q3: ['x'] })), /WIZARD_INVALID/, '400', 400);
      const inline = pedagogy.dryRunInline({ structure: RCP, profile: profileOf('significativo') });
      eq(inline.pedagogical.manifestErrors, [], 'en línea');
      const big = { course: { title: 'x' }, modules: Array.from({ length: 21 }, (_, i) => ({ title: `M${i}`, chapters: [{ title: 'c' }] })) };
      await rejectsRe(Promise.resolve().then(() => pedagogy.dryRunInline({ structure: big })), /como máximo 20 módulos/, 'límite', 400);
    });
  } finally {
    if (ds && ds.isInitialized) await ds.destroy();
    for (const [k, env] of [['flag', 'DYNAMIC_COURSE_STRUCTURE'], ['allow', 'DYNAMIC_V2_ALLOWED_OWNERS'], ['rules', 'DYNAMIC_MANIFEST_RULES_VERSION'], ['atr', 'DYNAMIC_ACTIVITY_TYPE_RULES'], ['unowned', 'ALLOW_UNOWNED_COURSES']]) {
      if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k];
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

(async () => {
  console.log('Motor pedagógico V1 — check-pedagogy-engine');
  await pureChecks();
  if (PURE_ONLY) console.log('\n(--pure-only: parte DB SALTADA)');
  else await dbChecks();
  console.log(`\n${passed} OK, ${failed} fallidos`);
  if (failed > 0) {
    console.log('\nFallos:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err && f.err.message}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
