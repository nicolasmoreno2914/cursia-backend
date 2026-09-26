#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — R11a: facts, Course Shell, ensamblador de capítulo y
// validación server-side de los artifacts LLM v3.
//
// Parte pura (siempre; CI: --pure-only):
//   - facts de cursos de 2 y 4 módulos con las 4 combinaciones video/actividad,
//     y fallas fuertes ante datos faltantes/incoherentes;
//   - secuencias exactas de slots por combinación + transición al examen del módulo;
//   - sin referencias fantasma (video OFF → sin "video"; actividad OFF → sin
//     "actividad"/"práctica" en transiciones);
//   - lint de números: todo número del shell ∈ factsNumberSet;
//   - validadores de intros v3 (+ lints RESOURCE_MENTION / QUANTITY_CLAIM),
//     payload h5p (rotación + R7), GIFT final, dispatcher server-side, datos del video;
//   - CLEAN_SAFE en todos los labels (7 temas × {CLEAN_SAFE, ENHANCED});
//   - determinismo.
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570, dir temporal que se
// destruye): SchedulerService real — claim v3 con activityType / plan del video /
// rango del examen final / capítulos del journey; completeItem RECHAZA payloads
// inválidos (item → retrying con códigos, artifact sin vincular), acepta los
// válidos, falla el claim de video_interactions sin duración medida, y sin
// lector configurado no completa (500).
//
// Usage: node scripts/check-v21-shell.js [--pure-only] [path/to/dist]

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
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error('   (¿corriste "npm run build" antes? — dist/ no se versiona)');
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

const S = loadDist('modules/course-shell/index.js');
const vc = loadDist('modules/visual-components/index.js');
const te = loadDist('modules/theme-engine/index.js');
const cp = loadDist('modules/course-profiles/course-profiles.js');
const h5p = loadDist('package/h5p/index.js');
const F = require('./lib/v21-shell-fixtures');
const VF = require('./lib/v21-video-fixture');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message.split('\n').join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg}: ${x} !== ${y}`);
}
function throwsRe(fn, re, msg) {
  try { fn(); } catch (e) {
    if (!re.test(e.message)) throw new Error(`${msg}: mensaje inesperado: ${e.message}`);
    return;
  }
  throw new Error(`${msg}: no lanzó`);
}
async function rejectsRe(p, re, msg, status) {
  try { await p; } catch (e) {
    if (!re.test(e.message)) throw new Error(`${msg}: mensaje inesperado: ${e.message}`);
    if (status !== undefined && typeof e.getStatus === 'function' && e.getStatus() !== status) throw new Error(`${msg}: status ${e.getStatus()} ≠ ${status}`);
    return;
  }
  throw new Error(`${msg}: no rechazó`);
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const codes = (r) => [...new Set(r.errors.map((e) => e.code))].sort();

const DIST = distRoot;
const THEMES = F.THEME_COMBOS.map((c) => ({ label: F.themeLabel(c), theme: te.resolveTheme(c) }));
const THEME = THEMES[0].theme;

function factsOf(course, opts = {}) {
  const finalExam = course.manifest.features.finalExam;
  return S.buildCourseFacts({
    manifest: course.manifest,
    blueprint: course.snapshot,
    assessment: opts.assessment || cp.defaultAssessmentProfile({ finalExam }),
    artifacts: opts.artifacts || F.measuredArtifacts(course.manifest),
    hours: opts.hours,
  });
}

/** Todos los labels del shell de un curso. */
function shellLabels(facts, course, theme, level) {
  const o = level ? { level } : undefined;
  const ci = F.courseIntroFixture();
  const out = [
    S.welcomeLabel(facts, ci, theme, o),
    S.audioWelcomeLabel(facts, theme, o),
    S.competenciesLabel(facts, ci, theme, o),
    S.methodologyLabel(facts, ci, theme, o),
    S.routeLabel(facts, theme, o),
    S.libroCardLabel(77, facts, theme, o),
    S.audiobookLabel(facts, theme, o),
    S.closingLabel(facts, ci, theme, o),
  ];
  facts.modules.forEach((m, i) => {
    out.push(S.moduleIntroLabel(m, F.moduleIntroFixture(course.manifest, i), facts, theme, o));
    if (m.examEnabled) out.push(S.examInfoLabel(m, facts, theme, o));
  });
  if (facts.finalExam.enabled) out.push(S.finalExamInfoLabel(facts, theme, o));
  return out;
}

/** Texto de los elementos con una clase (p.ej. las transiciones). */
function textOfClass(html, cls) {
  const out = [];
  const walk = (n) => {
    if (n.kind !== 'el') return;
    if ((n.attrs.class || '').split(/\s+/).includes(cls)) {
      out.push(vc.extractText(serialize(n)));
      return;
    }
    n.children.forEach(walk);
  };
  const serialize = (n) => {
    if (n.kind === 'text') return n.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const inner = n.children.map(serialize).join('');
    return `<${n.tag}>${inner}</${n.tag}>`;
  };
  walk(vc.parseHtml(html));
  return out.join(' ');
}

// I6: tipo h5p por UUID de capítulo (FNV-1a 32). Implementación INDEPENDIENTE del
// módulo para verificarlo, y vectores fijos compartidos con el frontend.
const VECTORS = require('./fixtures/v21-activity-type-vectors.json');
function fnvRef(str) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(str, 'utf8')) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const typeRef = (id) => ['questionset', 'dragtext', 'blanks'][fnvRef(id.toLowerCase()) % 3];
/** Capítulos de prueba con tipo conocido: 1 → questionset, 2 → dragtext, 3 → blanks. */
const CH_BY_N = { 1: VECTORS.vectors[0].chapterId, 2: VECTORS.vectors[1].chapterId, 3: VECTORS.vectors[2].chapterId };
const chOf = (n) => CH_BY_N[((n - 1) % 3) + 1];

const seqOf = (slots) => slots.map((s) => (s.kind === 'label' ? `label:${s.role}` : s.kind));

// ════════════════════════════════════════════════════════════════════════════
// Parte pura
// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  const c2 = F.course2(DIST);
  const c4 = F.course4(DIST);
  const f2 = factsOf(c2, { hours: 40 });
  const f4 = factsOf(c4);

  await check('facts 2 módulos: conteos, capítulos (4 combinaciones V/A), módulos, evaluación, audio y horas', () => {
    eq(f2.counts, { modules: 2, chapters: 4, videos: 2, activities: 2, activitiesByVariant: { h5p: 2, scorm: 0 }, exams: 1, finalExam: true, evaluations: 2 }, 'counts');
    eq(f2.chapters.map((c) => [c.number, c.moduleNumber, c.indexInModule, c.videoEnabled, c.activityEnabled, c.activityVariant, c.activityType, c.slideCount]),
      [[1, 1, 1, true, true, 'h5p', typeRef(f2.chapters[0].id), 8], [2, 1, 2, true, false, null, null, 9], [3, 2, 1, false, true, 'h5p', typeRef(f2.chapters[2].id), 10], [4, 2, 2, false, false, null, null, 8]], 'chapters');
    eq(f2.modules.map((m) => [m.number, m.title, m.chapterNumbers, m.examEnabled, m.examQuestionCount]),
      [[1, 'Bases del servicio', [1, 2], true, 12], [2, 'Relación con el cliente', [3, 4], false, null]], 'modules');
    eq(f2.finalExam, { enabled: true, questionCount: 20 }, 'final');
    eq(f2.assessment.kinds.exam, { passingGrade: 70, attempts: 3, gradeMethod: 'highest' }, 'exam kind');
    eq(f2.assessment.kinds.activity.attempts, 0, 'formativos ilimitados');
    eq(f2.audio.audiobookParts.map((p) => [p.chapterNumber, +p.offsetSeconds.toFixed(2)]), [[1, 0], [2, 181.44], [3, 399.88], [4, 655.32]], 'offsets');
    eq(+f2.audio.audiobookSeconds.toFixed(2), 947.76, 'total audiolibro');
    eq(f2.hours, { value: 40, source: 'definida por la institución' }, 'horas');
    assert(Object.isFrozen(f2) && Object.isFrozen(f2.chapters[0]) && Object.isFrozen(f2.counts), 'facts no congelado');
  });

  await check('facts 4 módulos (scorm, sin final, exámenes alternados): conteos, variant y sin activityType h5p', () => {
    eq(f4.counts, { modules: 4, chapters: 8, videos: 4, activities: 4, activitiesByVariant: { h5p: 0, scorm: 4 }, exams: 2, finalExam: false, evaluations: 2 }, 'counts');
    const combos = f4.chapters.map((c) => `${c.videoEnabled ? 'V' : '-'}${c.activityEnabled ? 'A' : '-'}`);
    for (const k of ['VA', '-A', 'V-', '--']) assert(combos.filter((x) => x === k).length === 2, `combinación ${k} ≠ 2 (${combos})`);
    assert(f4.chapters.every((c) => c.activityType === null) && f4.chapters.filter((c) => c.activityEnabled).every((c) => c.activityVariant === 'scorm'), 'variant scorm');
    eq(f4.modules.map((m) => m.examQuestionCount), [12, null, 14, null], 'preguntas por módulo');
    eq(f4.finalExam, { enabled: false, questionCount: null }, 'sin final');
    eq(f4.hours, null, 'sin horas');
  });

  await check('facts: overrides del perfil por tipo (nota mínima, intentos, método)', () => {
    const p = cp.defaultAssessmentProfile({ finalExam: true });
    p.overrides.activity = 60; p.overrides.finalExam = 80; p.attempts.exam = 2; p.gradeMethod.exam = 'average';
    const f = factsOf(c2, { assessment: p });
    eq([f.assessment.kinds.activity.passingGrade, f.assessment.kinds.finalExam.passingGrade, f.assessment.kinds.exam.passingGrade, f.assessment.kinds.exam.attempts, f.assessment.kinds.exam.gradeMethod],
      [60, 80, 70, 2, 'average'], 'resuelto');
  });

  await check('facts falla fuerte: dato medido faltante o incoherente (nunca un default)', () => {
    const base = () => F.measuredArtifacts(c2.manifest);
    const cid = c2.manifest.modules[0].chapters[0].chapterId;
    const mNoExam = c2.manifest.modules[1].moduleId;
    const cases = [
      ['slideCount faltante', (a) => { delete a.slideCountByChapter[cid]; }, /slideCount del capítulo 1/],
      ['slideCount 0', (a) => { a.slideCountByChapter[cid] = 0; }, /slideCount/],
      ['parte de audiolibro faltante', (a) => { a.audiobookParts.shift(); }, /audiolibro sin la parte del capítulo 1/],
      ['audio de bienvenida no medido', (a) => { a.audioWelcomeSeconds = 0; }, /audioWelcomeSeconds/],
      ['preguntas en módulo sin examen', (a) => { a.examQuestionCountByModule[mNoExam] = 5; }, /no tiene examen/],
      ['preguntas del examen faltantes', (a) => { a.examQuestionCountByModule = {}; }, /preguntas del examen del módulo 1/],
      ['preguntas del final faltantes', (a) => { delete a.finalExamQuestionCount; }, /examen final/],
      ['libroWordCount', (a) => { a.libroWordCount = 1.5; }, /libroWordCount/],
      ['capítulo desconocido en audiolibro', (a) => { a.audiobookParts.push({ chapterId: 'x', seconds: 3 }); }, /desconocido/],
    ];
    for (const [name, mut, re] of cases) {
      const a = base();
      mut(a);
      throwsRe(() => factsOf(c2, { artifacts: a }), re, name);
    }
    throwsRe(() => S.buildCourseFacts({ manifest: c2.manifest, blueprint: c4.snapshot, assessment: cp.defaultAssessmentProfile({ finalExam: true }), artifacts: base() }), /sha distinto/, 'Blueprint ajeno');
    const m = clone(c2.manifest); m.rulesVersion = 2;
    throwsRe(() => S.buildCourseFacts({ manifest: m, blueprint: c2.snapshot, assessment: cp.defaultAssessmentProfile({ finalExam: true }), artifacts: base() }), /rulesVersion 3/, 'Manifest v2');
    throwsRe(() => factsOf(c2, { assessment: cp.defaultAssessmentProfile({ finalExam: false }) }), /perfil de evaluación inválido/, 'perfil sin final en curso con final');
    throwsRe(() => factsOf(c2, { hours: -1 }), /hours/, 'horas negativas');
  });

  await check('activityTypeForChapter(chapterId): FNV-1a 32 estándar sobre el UUID en minúsculas, vectores fijos, estable ante reordenamientos (I6)', () => {
    eq(S.ACTIVITY_H5P_ROTATION, ['questionset', 'dragtext', 'blanks'], 'rotación (R-011: sin singlechoiceset)');
    eq(VECTORS.rotation, S.ACTIVITY_H5P_ROTATION, 'rotación del fixture');
    // Vectores estándar de FNV-1a 32 (tabla de referencia de Fowler/Noll/Vo).
    eq([S.fnv1a32(''), S.fnv1a32('a'), S.fnv1a32('foobar')], [0x811c9dc5, 0xe40c292c, 0xbf9cf968], 'FNV-1a estándar');
    assert(VECTORS.vectors.length === 5, 'se esperan 5 vectores');
    const seen = new Set();
    for (const v of VECTORS.vectors) {
      eq([S.fnv1a32(v.chapterId.toLowerCase()), S.activityTypeForChapter(v.chapterId)], [v.fnv1a32, v.type], v.chapterId);
      eq([fnvRef(v.chapterId.toLowerCase()), typeRef(v.chapterId)], [v.fnv1a32, v.type], `referencia independiente ${v.chapterId}`);
      seen.add(v.type);
    }
    eq([...seen].sort(), ['blanks', 'dragtext', 'questionset'], 'los vectores cubren los 3 tipos');
    eq(S.activityTypeForChapter(VECTORS.vectors[3].chapterId), S.activityTypeForChapter(VECTORS.vectors[3].chapterId.toLowerCase()), 'insensible a mayúsculas');
    for (const bad of ['', '  ', 1, null, undefined]) throwsRe(() => S.activityTypeForChapter(bad), /ACTIVITY_TYPE_INVALID_CHAPTER/, `chapterId ${JSON.stringify(bad)}`);
    // Reordenar capítulos (otro número global) no cambia el tipo de ninguno.
    const reordered = F.buildCourse(DIST, {
      courseId: 501, modules: [
        { examEnabled: false, chapters: [{ video: false, activity: true }, { video: true, activity: true }] },
        { examEnabled: true, chapters: [{ video: true, activity: true }, { video: false, activity: true }] },
      ],
    });
    const fr = factsOf(reordered, { artifacts: F.measuredArtifacts(reordered.manifest, { finalExamQuestionCount: 20 }) });
    for (const ch of fr.chapters) eq(ch.activityType, typeRef(ch.id), `cap ${ch.number}`);
  });

  await check('ensamblador: secuencias EXACTAS por combinación V/A (§F.3)', () => {
    const exp = {
      'VA': ['label:opening', 'presentation', 'label:deepening', 'label:video_primer', 'video_h5p', 'label:synthesis', 'label:activity_instruction', 'activity', 'label:closing'],
      '-A': ['label:opening', 'presentation', 'label:deepening', 'label:synthesis', 'label:activity_instruction', 'activity', 'label:closing'],
      'V-': ['label:opening', 'presentation', 'label:deepening', 'label:video_primer', 'video_h5p', 'label:synthesis', 'label:self_check', 'label:closing'],
      '--': ['label:opening', 'presentation', 'label:deepening', 'label:synthesis', 'label:self_check', 'label:closing'],
    };
    for (const [course, facts] of [[c2, f2], [c4, f4]]) {
      const all = S.assembleAllChapters(facts, F.experiencesFor(course.manifest), THEME);
      for (const { chapterNumber, slots } of all) {
        const ch = facts.chapters[chapterNumber - 1];
        const k = `${ch.videoEnabled ? 'V' : '-'}${ch.activityEnabled ? 'A' : '-'}`;
        eq(seqOf(slots), exp[k], `cap ${chapterNumber} (${k})`);
        eq(S.chapterSlotSequence(ch), exp[k], `chapterSlotSequence ${k}`);
        const act = slots.find((s) => s.kind === 'activity');
        if (act) eq(act.variant, ch.activityVariant, 'variant del slot');
      }
    }
  });

  await check('ensamblador: transición "evaluación del módulo" SOLO en el último capítulo de un módulo con examen', () => {
    for (const [course, facts] of [[c2, f2], [c4, f4]]) {
      const all = S.assembleAllChapters(facts, F.experiencesFor(course.manifest), THEME);
      for (const { chapterNumber, slots } of all) {
        const ch = facts.chapters[chapterNumber - 1];
        const mod = facts.modules.find((m) => m.id === ch.moduleId);
        const last = mod.chapterNumbers[mod.chapterNumbers.length - 1] === ch.number;
        const t = textOfClass(slots.find((s) => s.role === 'closing').html, 'cvc-transition');
        const has = /evaluación del módulo/.test(t);
        eq(has, last && mod.examEnabled, `cap ${chapterNumber}`);
        if (has) assert(t.includes(`${mod.examQuestionCount} preguntas`) && t.includes('70 de 100'), `datos del examen: ${t}`);
        const next = facts.chapters[chapterNumber];
        if (next) assert(t.includes(`Continúa con el capítulo ${next.number}: ${next.title}.`), `puente al siguiente: ${t}`);
        else assert(t.includes('terminas el recorrido de los contenidos'), 'último capítulo del curso');
      }
    }
    // Entradas incoherentes → fallo fuerte.
    const ch = f2.chapters[0];
    const base = { chapterFacts: ch, moduleFacts: f2.modules[0], experience: F.experienceFor(ch.id), assessment: f2.assessment, isLastChapterOfModule: false, nextChapter: { number: 2, title: 'x' }, theme: THEME };
    throwsRe(() => S.assembleChapter({ ...base, isLastChapterOfModule: true }), /isLastChapterOfModule/, 'último mal declarado');
    throwsRe(() => S.assembleChapter({ ...base, moduleFacts: f2.modules[1] }), /no pertenece/, 'módulo ajeno');
    throwsRe(() => S.assembleChapter({ ...base, experience: F.experienceFor('otro-capitulo') }), /experience.chapterId/, 'experience ajeno');
    throwsRe(() => S.assembleChapter({ ...base, nextChapter: { number: 5, title: 'x' } }), /nextChapter/, 'next ≠ N+1');
    const bad = F.experienceFor(ch.id); bad.bridge_to_next = 'Ahora mira el video.';
    throwsRe(() => S.assembleChapter({ ...base, experience: bad }), /VC_INVALID.*RESOURCE_MENTION/, 'experience con recurso');
  });

  await check('sin referencias fantasma: video OFF → ningún "video"; actividad OFF → sin "actividad"/"práctica" en transiciones; ON → sí', () => {
    for (const [course, facts] of [[c2, f2], [c4, f4]]) {
      for (const { theme } of [THEMES[0], THEMES[6]]) {
        const all = S.assembleAllChapters(facts, F.experiencesFor(course.manifest), theme);
        for (const { chapterNumber, slots } of all) {
          const ch = facts.chapters[chapterNumber - 1];
          const labels = slots.filter((s) => s.kind === 'label');
          const text = labels.map((s) => `${s.name} ${vc.extractText(s.html)}`).join(' ').toLowerCase();
          const trans = labels.map((s) => `${s.name} ${textOfClass(s.html, 'cvc-transition')}`).join(' ').toLowerCase();
          const selfLead = ch.activityEnabled ? '' : vc.extractText(slots.find((s) => s.role === 'self_check').html).toLowerCase();
          if (!ch.videoEnabled) assert(!/video/.test(text), `cap ${chapterNumber}: menciona video con video OFF`);
          else assert(/ahora mira el video/.test(trans), `cap ${chapterNumber}: falta la transición al video`);
          if (!ch.activityEnabled) {
            assert(!/actividad/.test(text), `cap ${chapterNumber}: "actividad" con actividad OFF`);
            assert(!/pr[aá]ctica/.test(trans), `cap ${chapterNumber}: "práctica" en transiciones con actividad OFF: ${trans}`);
            assert(/repasa/.test(trans) && /repasa lo aprendido/.test(selfLead), `cap ${chapterNumber}: el puente no dice "repasa"`);
          } else {
            const instr = vc.extractText(slots.find((s) => s.role === 'activity_instruction').html);
            assert(/actividad práctica que sigue es calificada/.test(instr) && instr.includes('70 de 100') && /todas las veces que quieras/.test(instr), `instrucción: ${instr}`);
          }
        }
      }
    }
    // Shell: un curso sin videos/actividades/exámenes no los nombra.
    const cb = F.courseBare(DIST);
    const fb = factsOf(cb);
    const txt = shellLabels(fb, cb, THEME).map((l) => vc.extractText(l.html)).join(' ').toLowerCase();
    for (const w of ['video', 'actividad', 'evaluaci', 'examen', 'preguntas:']) assert(!txt.includes(w), `shell de curso mínimo menciona "${w}"`);
    // Y uno con todo los nombra (metodología + bienvenida + ruta).
    const t2 = shellLabels(f2, c2, THEME).map((l) => vc.extractText(l.html)).join(' ');
    for (const w of ['Video interactivo', 'Actividad práctica', 'Evaluación del módulo', 'Evaluación final', 'Libro Guía', 'Audiolibro']) assert(t2.includes(w), `falta "${w}"`);
    assert(/En los capítulos que lo incluyen, un video/.test(t2) && /Al cierre de los módulos que la incluyen/.test(t2), 'metodología: alcance parcial');
    throwsRe(() => S.examInfoLabel(f2.modules[1], f2, THEME), /no tiene examen/, 'examen inexistente');
    throwsRe(() => S.finalExamInfoLabel(f4, THEME), /no tiene examen final/, 'final inexistente');
  });

  await check('lint de números: todo número del shell y de las transiciones ∈ factsNumberSet (2 y 4 módulos, con horas)', () => {
    for (const [course, facts] of [[c2, f2], [c4, f4], [c2, factsOf(c2, { hours: 36 })]]) {
      for (const l of shellLabels(facts, course, THEME, 'enhanced')) {
        const bad = S.lintShellNumbers(`${l.name} ${vc.extractText(l.html)}`, facts);
        eq(bad, [], `números fuera de facts en "${l.name}"`);
      }
      for (const { slots } of S.assembleAllChapters(facts, F.experiencesFor(course.manifest), THEME)) {
        for (const s of slots.filter((x) => x.kind === 'label')) {
          const det = s.role === 'activity_instruction' ? vc.extractText(s.html) : textOfClass(s.html, 'cvc-transition');
          eq(S.lintShellNumbers(`${s.name} ${det}`, facts), [], `números fuera de facts en ${s.name}`);
        }
      }
    }
    eq(S.lintShellNumbers('Este curso tiene 99 capítulos y 4 módulos', f2), [99], 'detecta un número inventado');
    const set = S.factsNumberSet(f2);
    for (const n of [2, 4, 12, 20, 70, 3, 100, 18432, 40, 58]) assert(set.has(n), `factsNumberSet sin ${n}`);
  });

  await check('shell: datos medidos y tokens (audio, duración R10, Libro, horas) + CLEAN_SAFE/ENHANCED mismo texto', () => {
    const labels = shellLabels(f2, c2, THEME);
    const byName = Object.fromEntries(labels.map((l) => [l.name, l]));
    const aw = byName['Audio de bienvenida'].html;
    assert(aw.includes('<audio controls preload="none" src="@@PLUGINFILE@@/audio_bienvenida.mp3"'), 'audio de bienvenida');
    assert(vc.extractText(aw).includes('Duración: 0 min 58 s.'), 'duración medida (formatDurationEs)');
    const ab = vc.extractText(byName['Audiolibro'].html);
    assert(ab.includes('Duración total: 15 min 48 s.') && ab.includes('empieza en 3 min 01 s · dura 3 min 38 s'), `índice del audiolibro: ${ab}`);
    assert(byName['Libro Guía'].html.includes('href="$@RESOURCEVIEWBYID*77@$"'), 'token del Libro');
    assert(vc.extractText(byName['Bienvenida'].html).includes('Duración estimada: 40 h (definida por la institución).'), 'horas etiquetadas');
    for (const w of ['certificado', 'narración profesional', 'minutos por pregunta']) {
      assert(!labels.some((l) => vc.extractText(l.html).toLowerCase().includes(w)), `afirma "${w}"`);
    }
    const enh = shellLabels(f2, c2, THEME, 'enhanced');
    labels.forEach((l, i) => eq(vc.extractText(enh[i].html), vc.extractText(l.html), `texto CLEAN_SAFE = ENHANCED (${l.name})`));
    throwsRe(() => S.libroCardLabel(0, f2, THEME), /libroMid/, 'libroMid inválido');
    throwsRe(() => S.welcomeLabel(f2, { ...F.courseIntroFixture(), welcome: 'Muy corto.' }, THEME), /COURSE_INTRO_V3_INVALID.*WORD_RANGE/, 'intro inválida no se renderiza');
  });

  await check('CLEAN_SAFE: lintCleanSafe en TODOS los labels del shell y del capítulo (7 temas × {CLEAN_SAFE, ENHANCED})', () => {
    let n = 0;
    for (const { label, theme } of THEMES) {
      for (const level of [undefined, 'enhanced']) {
        for (const [course, facts] of [[c2, f2], [c4, f4]]) {
          for (const l of shellLabels(facts, course, theme, level)) {
            const r = vc.lintCleanSafe(l.html);
            assert(r.ok, `${label}/${level || 'clean'}/${l.name}: ${JSON.stringify(r.errors.slice(0, 2))}`);
            if (!level) assert(!/<style|<script|<details|aria-|data-| id=/.test(l.html), `${l.name}: marcado ENHANCED en CLEAN_SAFE`);
            n++;
          }
          for (const { slots } of S.assembleAllChapters(facts, F.experiencesFor(course.manifest), theme, level ? { level } : undefined)) {
            for (const s of slots.filter((x) => x.kind === 'label')) {
              const r = vc.lintCleanSafe(s.html);
              assert(r.ok, `${label}/${level || 'clean'}/${s.name}: ${JSON.stringify(r.errors.slice(0, 2))}`);
              n++;
            }
          }
        }
      }
    }
    assert(n > 700, `pocos labels (${n})`);
    console.log(`   (${n} labels)`);
  });

  await check('determinismo: facts, labels y capítulos byte-idénticos en dos corridas; entradas no mutadas', () => {
    const a1 = F.measuredArtifacts(c2.manifest);
    const snapBefore = JSON.stringify([c2.manifest, c2.snapshot, a1]);
    const fa = factsOf(c2, { artifacts: a1, hours: 40 });
    const fb = factsOf(F.course2(DIST), { hours: 40 });
    eq(fa, fb, 'facts');
    eq(JSON.stringify([c2.manifest, c2.snapshot, a1]), snapBefore, 'entradas mutadas');
    eq(shellLabels(fa, c2, THEME, 'enhanced'), shellLabels(fb, c2, THEME, 'enhanced'), 'labels');
    eq(S.assembleAllChapters(fa, F.experiencesFor(c2.manifest), THEME), S.assembleAllChapters(fb, F.experiencesFor(c2.manifest), THEME), 'capítulos');
  });

  await check('course_intro v3: válida pasa; cada clase de error se detecta (forma, palabras, lints, bibliografía)', () => {
    eq(S.validateCourseIntroV3(F.courseIntroFixture()), { ok: true, errors: [] }, 'válida');
    const cases = [
      ['schemaVersion', (d) => { d.schemaVersion = 2; }, 'SCHEMA_VERSION'],
      ['campo extra', (d) => { d.extra = 'x'; }, 'UNKNOWN_FIELD'],
      ['welcome corto', (d) => { d.welcome = 'Hola y bienvenida.'; }, 'WORD_RANGE'],
      ['welcome con recurso', (d) => { d.welcome = d.welcome + ' Mira el video del capítulo con atención.'; }, 'RESOURCE_MENTION'],
      ['welcome con cantidad', (d) => { d.welcome = d.welcome + ' Son 3 módulos intensos.'; }, 'QUANTITY_CLAIM'],
      ['welcome con HTML', (d) => { d.welcome = d.welcome + ' <b>fuerte</b>'; }, 'HTML_IN_TEXT'],
      ['competencias 3', (d) => { d.competencies = d.competencies.slice(0, 3); }, 'COUNT_RANGE'],
      ['competencia con examen', (d) => { d.competencies[0] = 'Aprobar el examen final.'; }, 'RESOURCE_MENTION'],
      ['nota metodológica larga', (d) => { d.methodology_note = 'palabra '.repeat(81).trim(); }, 'WORD_RANGE'],
      ['nota con horas', (d) => { d.methodology_note = 'Dedica 20 horas semanales.'; }, 'QUANTITY_CLAIM'],
      ['closing vacío', (d) => { d.closing = '  '; }, 'TEXT_EMPTY'],
      ['bibliografía 4', (d) => { d.bibliography = d.bibliography.slice(0, 4); }, 'COUNT_RANGE'],
      ['bibliografía con URL', (d) => { d.bibliography[0].publisher = 'https://editorial.example'; }, 'URL_IN_TEXT'],
      ['bibliografía con ISBN', (d) => { d.bibliography[1].title = 'Libro ISBN 978-1'; }, 'URL_IN_TEXT'],
      ['welcome con URL', (d) => { d.welcome = d.welcome + ' Más en www.ejemplo.com'; }, 'URL_IN_TEXT'],
      ['año string', (d) => { d.bibliography[2].year = '2005'; }, 'TYPE_MISMATCH'],
      ['campo extra en referencia', (d) => { d.bibliography[3].url = 'x'; }, 'UNKNOWN_FIELD'],
      ['competencia larga', (d) => { d.competencies[0] = 'x'.repeat(301); }, 'TEXT_TOO_LONG'],
      ['closing largo', (d) => { d.closing = 'y'.repeat(801); }, 'TEXT_TOO_LONG'],
    ];
    for (const [name, mut, code] of cases) {
      const d = F.courseIntroFixture(); mut(d);
      const r = S.validateCourseIntroV3(d);
      assert(!r.ok && codes(r).includes(code), `${name}: ${JSON.stringify(codes(r))} sin ${code}`);
    }
    // La bibliografía NO pasa por los lints (títulos legítimos con "evaluación" o cifras).
    const d = F.courseIntroFixture(); d.bibliography[0].title = 'Evaluación de riesgos ISO 9001 en 3 capítulos';
    assert(S.validateCourseIntroV3(d).ok, 'bibliografía linteada');
    const all = F.courseIntroFixture(); all.welcome = 'Mira el video.'; all.competencies = []; all.extra = 1;
    assert(codes(S.validateCourseIntroV3(all)).length >= 4, 'no junta todos los errores');
    eq(S.validateCourseIntroV3(null).errors[0].code, 'NOT_OBJECT', 'no objeto');
  });

  await check('module_intro v3: journey = capítulos del módulo exactos y en orden; outcomes, lints, bibliografía', () => {
    const ids = c2.manifest.modules[0].chapters.map((c) => c.chapterId);
    eq(S.validateModuleIntroV3(F.moduleIntroFixture(c2.manifest, 0), { chapterIds: ids }), { ok: true, errors: [] }, 'válida');
    const cases = [
      ['journey reordenado', (d) => { d.journey.reverse(); }, 'JOURNEY_MISMATCH'],
      ['journey incompleto', (d) => { d.journey.pop(); }, 'JOURNEY_MISMATCH'],
      ['journey con extra', (d) => { d.journey.push({ chapterId: 'x', line: 'y' }); }, 'JOURNEY_MISMATCH'],
      ['línea con capítulo N', (d) => { d.journey[0].line = 'Como vimos en el capítulo 3, seguimos.'; }, 'QUANTITY_CLAIM'],
      ['línea con actividad', (d) => { d.journey[0].line = 'Cierra con la actividad práctica del tema.'; }, 'RESOURCE_MENTION'],
      ['outcomes 6', (d) => { d.outcomes = [...d.outcomes, 'a', 'b', 'c']; }, 'COUNT_RANGE'],
      ['presentación larga', (d) => { d.presentation = 'z'.repeat(2001); }, 'TEXT_TOO_LONG'],
      ['línea larga', (d) => { d.journey[0].line = 'w'.repeat(401); }, 'TEXT_TOO_LONG'],
      ['bibliografía 5', (d) => { d.bibliography = [...d.bibliography, ...d.bibliography, d.bibliography[0]]; }, 'COUNT_RANGE'],
      ['campo extra en paso', (d) => { d.journey[0].order = 1; }, 'UNKNOWN_FIELD'],
    ];
    for (const [name, mut, code] of cases) {
      const d = F.moduleIntroFixture(c2.manifest, 0); mut(d);
      const r = S.validateModuleIntroV3(d, { chapterIds: ids });
      assert(!r.ok && codes(r).includes(code), `${name}: ${JSON.stringify(codes(r))} sin ${code}`);
    }
    throwsRe(() => S.validateModuleIntroV3({}, { chapterIds: [] }), /MODULE_INTRO_EXPECT_INVALID/, 'expect vacío');
  });

  await check('activity h5p: payload válido para los 3 tipos calificados; tipo ≠ rotación, desconocido, campos de Cursia y data inválida se rechazan', () => {
    const typeForN = { questionset: 1, dragtext: 2, blanks: 3 };
    for (const [t, n] of Object.entries(typeForN)) {
      eq(S.validateH5pActivityPayload(F.h5pPayload(t), { chapterId: chOf(n), itemKey: `activity:ch${n}` }), { ok: true, errors: [] }, t);
      eq(S.validateH5pActivityPayload(F.h5pPayload(t), { chapterId: chOf(n + 3), itemKey: `activity:ch${n}` }).ok, true, `${t} (vuelta 2)`);
    }
    const r1 = S.validateH5pActivityPayload(F.h5pPayload('dragtext'), { chapterId: chOf(1), itemKey: 'activity:ch1' });
    eq(codes(r1), ['ACTIVITY_TYPE_MISMATCH'], 'mismatch');
    eq(codes(S.validateH5pActivityPayload({ type: 'flashcards', data: {} }, { chapterId: chOf(1), itemKey: 'a:1' })), ['ACTIVITY_TYPE_UNKNOWN'], 'desconocido');
    // R-011: singlechoiceset es un tipo conocido pero NUNCA calificable — rechazo
    // explícito H5P_TYPE_NOT_GRADABLE, incluso si el capítulo pidiera otro tipo
    // o si por coincidencia se sobreescribiera el `type` esperado.
    for (const n of [1, 2, 3]) {
      eq(codes(S.validateH5pActivityPayload(F.h5pPayload('singlechoiceset'), { chapterId: chOf(n), itemKey: `a:${n}` })), ['H5P_TYPE_NOT_GRADABLE'], `singlechoiceset no calificable (cap ${n})`);
    }
    // Forma del ejecutor R11b: data = entrada COMPLETA de R7 (Cursia pone itemKey y passPercentage).
    const full = F.h5pPayload('questionset'); full.data.itemKey = 'a:1'; full.data.passPercentage = 60;
    eq(S.validateH5pActivityPayload(full, { chapterId: chOf(1), itemKey: 'a:1' }), { ok: true, errors: [] }, 'entrada completa de R7');
    const otherKey = clone(full); otherKey.data.itemKey = 'activity:otro';
    eq(codes(S.validateH5pActivityPayload(otherKey, { chapterId: chOf(1), itemKey: 'a:1' })), ['ITEM_KEY_MISMATCH'], 'itemKey ajeno');
    const badPass = clone(full); badPass.data.passPercentage = 150;
    eq(codes(S.validateH5pActivityPayload(badPass, { chapterId: chOf(1), itemKey: 'a:1' })), ['H5P_INPUT_INVALID'], 'passPercentage fuera de rango');
    const dtPass = F.h5pPayload('dragtext'); dtPass.data.passPercentage = 70;
    eq(codes(S.validateH5pActivityPayload(dtPass, { chapterId: chOf(2), itemKey: 'a:2' })), ['H5P_INPUT_INVALID'], 'passPercentage en DragText');
    const badData = F.h5pPayload('blanks'); badData.data.questions = ['Sin ningún hueco en la frase.'];
    eq(codes(S.validateH5pActivityPayload(badData, { chapterId: chOf(3), itemKey: 'a:3' })), ['H5P_INPUT_INVALID'], 'data inválida (R7)');
    const html = F.h5pPayload('questionset'); html.data.title = '<b>x</b>';
    eq(codes(S.validateH5pActivityPayload(html, { chapterId: chOf(1), itemKey: 'a:1' })), ['H5P_INPUT_INVALID'], 'HTML en data');
    eq(codes(S.validateH5pActivityPayload([], { chapterId: chOf(1), itemKey: 'a:1' })), ['NOT_OBJECT'], 'no objeto');
    eq(codes(S.validateH5pActivityPayload({ type: 'questionset', data: {}, extra: 1 }, { chapterId: chOf(1), itemKey: 'a:1' })).includes('UNKNOWN_FIELD'), true, 'extra');
  });

  await check('C1 (sonda g5probe/p3): cifras, cantidades en palabras y afirmaciones prohibidas en intros → rechazadas; el shell nunca las renderiza', () => {
    const bad = F.courseIntroFixture();
    bad.welcome = bad.welcome + ' A lo largo de tres módulos y nueve capítulos, en 6 semanas y 40 horas cronológicas, obtendrás tu certificado oficial. Incluye 12 lecciones y 30 ejercicios.';
    bad.methodology_note = 'Mira cada clase grabada y resuelve los cuestionarios; en 4 semanas completarás las 12 lecciones.';
    const r = S.validateCourseIntroV3(bad);
    assert(!r.ok, 'la intro de la sonda p3 pasó la validación');
    for (const code of ['DIGIT_IN_TEXT', 'QUANTITY_CLAIM', 'FORBIDDEN_CLAIM']) assert(codes(r).includes(code), `falta ${code}: ${JSON.stringify(codes(r))}`);
    const matches = r.errors.map((e) => e.message).join(' | ');
    for (const m of ['tres modulos', 'nueve capitulos', 'certificado', 'horas', 'semanas', '"6"', '"30"', '"12"', '"4"']) assert(matches.includes(m), `no detectó ${m}: ${matches}`);
    bad.welcome = bad.welcome.replace(' y 40 horas cronológicas', '');
    assert(!S.validateCourseIntroV3(bad).ok, 'sin las horas sigue siendo inválida');
    throwsRe(() => S.welcomeLabel(f2, bad, THEME), /COURSE_INTRO_V3_INVALID/, 'welcomeLabel renderiza la intro de p3');
    throwsRe(() => S.methodologyLabel(f2, bad, THEME), /COURSE_INTRO_V3_INVALID/, 'methodologyLabel renderiza la intro de p3');
    // Cada clase por separado, en cada campo de prosa de ambas intros.
    const cases = [
      ['Durante una docena de lecciones practicarás.', 'QUANTITY_CLAIM'],
      ['Son veinte ejercicios guiados.', 'QUANTITY_CLAIM'],
      ['Recibirás un diploma al terminar.', 'FORBIDDEN_CLAIM'],
      ['Incluye un PDF descargable.', 'FORBIDDEN_CLAIM'],
      ['Con narración profesional de cada tema.', 'FORBIDDEN_CLAIM'],
      ['Dedica unos minutos por día.', 'FORBIDDEN_CLAIM'],
      ['Aplica la norma ISO 9001 en tu área.', 'DIGIT_IN_TEXT'],
    ];
    for (const [txt, code] of cases) {
      eq(S.lintShellProse(txt).map((h) => h.code).includes(code), true, `${txt} → ${code}`);
      const ci = F.courseIntroFixture(); ci.competencies[1] = txt;
      assert(codes(S.validateCourseIntroV3(ci)).includes(code), `competencia: ${txt}`);
      const mi = F.moduleIntroFixture(c2.manifest, 0); mi.outcomes[0] = txt;
      assert(codes(S.validateModuleIntroV3(mi, { chapterIds: c2.manifest.modules[0].chapters.map((c) => c.chapterId) })).includes(code), `outcome: ${txt}`);
    }
    // Prosa normal sin cifras: sin falsos positivos ("a la hora de", "una semana" no se cuenta como cantidad; "dos formas de").
    eq(S.lintShellProse('A la hora de atender, hay dos formas de escuchar y una semana cualquiera lo demuestra.'), [], 'falsos positivos');
    // Bibliografía exenta (años y títulos con cifras).
    const b = F.courseIntroFixture(); b.bibliography[0].title = 'ISO 9001 en 3 capítulos';
    assert(S.validateCourseIntroV3(b).ok, 'bibliografía linteada');
  });

  await check('C1 (b): gate de render — assertShellNumbers lanza SHELL_NUMBER_NOT_FROM_FACTS; títulos del Blueprint exentos; todos los labels lo pasan', () => {
    throwsRe(() => S.assertShellNumbers({ name: 'Bienvenida', html: '<div><p>Incluye 30 ejercicios</p></div>' }, f2), /SHELL_NUMBER_NOT_FROM_FACTS.*30/, 'cifra inventada');
    S.assertShellNumbers({ name: 'Bienvenida', html: `<div><p>${f2.chapters[0].title} · 4 capítulos</p></div>` }, f2);
    // Un título con cifras (dato de la institución) no dispara el gate.
    const iso = F.buildCourse(DIST, { courseId: 509, title: 'Gestión ISO 9001:2015', finalExam: false, modules: [{ examEnabled: false, chapters: [{ video: false, activity: false }] }] });
    const fi = factsOf(iso);
    const w = S.welcomeLabel(fi, F.courseIntroFixture(), THEME);
    assert(vc.extractText(w.html).includes('9001:2015'), 'el título con cifras se muestra');
    for (const l of shellLabels(f2, c2, THEME)) S.assertShellNumbers(l, f2);
  });

  await check('I7: todo texto con letras/dígitos de los labels del shell y del capítulo va en <span class="nolink">', () => {
    for (const [course, facts] of [[c2, f2], [c4, f4]]) {
      for (const level of [undefined, 'enhanced']) {
        for (const l of shellLabels(facts, course, THEME, level)) eq(S.unprotectedText(l.html), [], `${l.name}`);
        for (const { slots } of S.assembleAllChapters(facts, F.experiencesFor(course.manifest), THEME, level ? { level } : undefined)) {
          for (const sl of slots.filter((x) => x.kind === 'label')) eq(S.unprotectedText(sl.html), [], sl.name);
        }
      }
    }
    eq(S.unprotectedText('<div><p>Hola <span class="nolink">mundo</span></p></div>'), ['Hola'], 'detecta texto desprotegido');
  });

  await check('M4/M12: el puente respeta los intentos de la actividad y omite el texto LLM antes de un examen o al final del curso', () => {
    eq(S.bridgeText({ activityEnabled: true, activityAttempts: 0, next: { number: 2, title: 'X' } }).startsWith('Si todavía no alcanzaste la nota mínima en la práctica, vuelve a intentarlo.'), true, 'ilimitados');
    eq(S.bridgeText({ activityEnabled: true, activityAttempts: 1, next: null }).includes('vuelve a intentarlo'), false, '1 intento: no promete reintentar');
    eq(S.bridgeText({ activityEnabled: true, activityAttempts: 3, next: null }).includes('te quedan intentos'), true, 'intentos finitos');
    const exps = F.experiencesFor(c2.manifest);
    const bridgeLLM = exps[f2.chapters[0].id].bridge_to_next;
    const all = S.assembleAllChapters(f2, exps, THEME);
    const closing = (n) => vc.extractText(all[n - 1].slots.find((x) => x.role === 'closing').html);
    assert(closing(1).includes(bridgeLLM), 'cap 1 (sigue otro capítulo): con puente LLM');
    assert(!closing(2).includes(bridgeLLM), 'cap 2 (antes del examen del módulo): sin puente LLM');
    assert(!closing(4).includes(bridgeLLM), 'cap 4 (fin del curso): sin puente LLM');
  });

  await check('GIFT final: conteo con parseGIFT, rango [5,40], bloque ilegible, vacío', () => {
    eq(S.validateExamGift(F.FINAL_GIFT), { ok: true, questionCount: 12, errors: [] }, 'válido');
    eq(codes(S.validateExamGift('')), ['GIFT_EMPTY'], 'vacío');
    eq(codes(S.validateExamGift('// solo comentario\nsin llaves')), ['GIFT_NO_QUESTIONS'], 'sin preguntas');
    const three = F.FINAL_GIFT.split('\n\n').slice(0, 3).join('\n\n');
    eq(codes(S.validateExamGift(three)), ['GIFT_QUESTION_COUNT'], 'pocas');
    const many = Array.from({ length: 41 }, () => F.FINAL_GIFT.split('\n\n')[0]).join('\n\n');
    eq([S.validateExamGift(many).questionCount, codes(S.validateExamGift(many))], [41, ['GIFT_QUESTION_COUNT']], 'más de 40');
    const broken = F.FINAL_GIFT + '\n\n::Rota:: Una pregunta que el parser no entiende {\n' + 'x'.repeat(10) + '\n' + 'y'.repeat(200) + '\n}';
    assert(codes(S.validateExamGift(broken)).includes('GIFT_UNPARSEABLE_BLOCK'), `bloque ilegible: ${JSON.stringify(codes(S.validateExamGift(broken)))}`);
    eq(S.giftCandidateBlocks(F.FINAL_GIFT), 12, 'bloques');
  });

  await check('validación server-side (dispatcher puro): cada tipo v3 acepta lo válido y rechaza lo inválido con códigos', () => {
    eq([S.v3ValidatedArtifactType('course_intro'), S.v3ValidatedArtifactType('module_intro'), S.v3ValidatedArtifactType('experience'),
      S.v3ValidatedArtifactType('video_interactions'), S.v3ValidatedArtifactType('activity', 'h5p'), S.v3ValidatedArtifactType('activity', 'scorm'),
      S.v3ValidatedArtifactType('final_exam'), S.v3ValidatedArtifactType('exam'), S.v3ValidatedArtifactType('content')],
    ['dynamic_course_intro_json', 'dynamic_module_intro_json', 'dynamic_experience_json', 'dynamic_video_interactions_json', 'dynamic_h5p_params_json', null, 'dynamic_exam_gift', null, null], 'tabla');
    const V = S.validateV3ItemArtifact;
    const ids = c2.manifest.modules[0].chapters.map((c) => c.chapterId);
    const plan = h5p.planInteractionCheckpoints(468);
    const vdoc = VF.makeInteractionsDoc(plan, { videoItemKey: 'video:c1', durationSec: 468 });
    const ok = [
      [{ type: 'course_intro', itemKey: 'course_intro:1' }, JSON.stringify(F.courseIntroFixture())],
      [{ type: 'module_intro', itemKey: 'module_intro:m', moduleChapterIds: ids }, JSON.stringify(F.moduleIntroFixture(c2.manifest, 0))],
      [{ type: 'experience', itemKey: 'experience:c1', chapterId: 'c1' }, JSON.stringify(F.experienceFor('c1'))],
      [{ type: 'video_interactions', itemKey: 'video_interactions:c1', video: { videoItemKey: 'video:c1', durationSec: 468 } }, JSON.stringify(vdoc)],
      [{ type: 'activity', variant: 'h5p', itemKey: 'activity:c3', chapterId: chOf(3) }, JSON.stringify(F.h5pPayload('blanks'))],
      [{ type: 'final_exam', itemKey: 'final_exam:1' }, F.FINAL_GIFT],
    ];
    for (const [ctx, text] of ok) eq(V(ctx, text).ok, true, `válido ${ctx.type}`);
    eq(V(ok[5][0], F.FINAL_GIFT).summary, { questionCount: 12 }, 'summary GIFT');
    eq(V(ok[3][0], JSON.stringify(vdoc)).summary, { interactionCount: 5 }, 'summary video');
    const bad = [
      [ok[0][0], '{no json', 'JSON_INVALID'],
      [ok[0][0], JSON.stringify({ ...F.courseIntroFixture(), closing: 'Revisa el video del capítulo para cerrar el recorrido completo y seguir aprendiendo siempre con tu equipo.' }), 'RESOURCE_MENTION'],
      [ok[1][0], JSON.stringify({ ...F.moduleIntroFixture(c2.manifest, 0), journey: [] }), 'JOURNEY_MISMATCH'],
      [ok[2][0], JSON.stringify(F.experienceFor('otro')), 'CHAPTER_ID_MISMATCH'],
      [ok[2][0], JSON.stringify({ ...F.experienceFor('c1'), bridge_to_next: 'Sigue con la actividad práctica siguiente.' }), 'RESOURCE_MENTION'],
      [ok[3][0], JSON.stringify({ ...vdoc, durationSec: 300 }), 'H5P_INPUT_INVALID'],
      [ok[3][0], JSON.stringify({ ...vdoc, videoItemKey: 'video:otro' }), 'H5P_INPUT_INVALID'],
      [ok[4][0], JSON.stringify(F.h5pPayload('questionset')), 'ACTIVITY_TYPE_MISMATCH'],
      [ok[5][0], 'sin preguntas', 'GIFT_NO_QUESTIONS'],
    ];
    for (const [ctx, text, code] of bad) {
      const r = V(ctx, text);
      assert(!r.ok && codes(r).includes(code), `${ctx.type}: ${JSON.stringify(codes(r))} sin ${code}`);
    }
    const msg = S.v3ValidationErrorMessage({ itemKey: 'experience:c1', type: 'experience' }, V(bad[4][0], bad[4][1]).errors);
    assert(msg.startsWith('v3_payload_invalid: experience experience:c1') && msg.includes('[RESOURCE_MENTION]'), msg);
    throwsRe(() => V({ type: 'exam', itemKey: 'exam:m' }, 'x'), /V3_VALIDATION_CONTEXT/, 'tipo sin validador');
    throwsRe(() => V({ type: 'video_interactions', itemKey: 'v' }, '{}'), /sin datos del video/, 'contexto incompleto');
  });

  await check('datos del video para video_interactions: plan R8 desde youtubeId + duración medida; faltantes fallan explícito', () => {
    const r = S.videoClaimFacts({ videoItemKey: 'video:c1', outputSummary: { youtubeVideoId: 'IdwOipZAeqY', durationSec: 468 } });
    eq([r.ok, r.video.youtubeId, r.video.durationSec, r.video.checkpoints.map((c) => c.atSec)], [true, 'IdwOipZAeqY', 468, [72, 157, 242, 326, 411]], 'plan');
    const m = S.videoClaimFacts({ videoItemKey: 'video:c1', outputSummary: { youtubeVideoId: 'IdwOipZAeqY' }, artifactMetadata: { durationSec: 300 } });
    eq(m.video.checkpoints.length, 3, 'duración desde la metadata del artifact');
    eq(S.videoClaimFacts({ videoItemKey: 'v', outputSummary: { durationSec: 300 } }).code, 'VIDEO_YOUTUBE_ID_MISSING', 'sin youtubeId');
    eq(S.videoClaimFacts({ videoItemKey: 'v', outputSummary: { youtubeVideoId: 'IdwOipZAeqY' } }).code, 'VIDEO_DURATION_MISSING', 'sin duración');
    eq(S.videoClaimFacts({ videoItemKey: 'v', outputSummary: { youtubeVideoId: 'IdwOipZAeqY', durationSec: 60 } }).code, 'VIDEO_TOO_SHORT_FOR_INTERACTIONS', 'muy corto');
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Parte DB: Postgres 16 desechable + SchedulerService real
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
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
  const { canonicalContextHash } = loadDist('modules/dynamic-generation/run-hash.js');

  const pgBin = findPgBin();
  const port = await freePort();
  assert(port !== 5570, 'puerto 5570 prohibido');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-r11-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-r11-cwd-'));
  const ROLE = 'postgres.r11localtest01';
  const DB = 'r11db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = { flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS, rules: process.env.DYNAMIC_MANIFEST_RULES_VERSION, unowned: process.env.ALLOW_UNOWNED_COURSES };
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`\nPostgres ${pgBin} en 127.0.0.1:${port} (data ${dataDir})`);
    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', async (c) => {
      await c.query(`create database ${DB}`);
      await c.query(`create role "${ROLE}" superuser login`);
    });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    // Esquema de staging con R3 + R4 (mismo orden que check-v21-manifest-v3).
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    let res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({}));
    assert(res.code === 0, `migrate-production-jobs-constraints: ${res.out}`);
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js']) {
      res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out}`);
    }

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'Curso R11', 'dynamic') returning id`, [OWNER]);
    const cid = course.id;
    const M1 = '00000000-0000-4000-8000-0000000001a1';
    const M2 = '00000000-0000-4000-8000-0000000001a2';
    const C1 = '00000000-0000-4000-8000-0000000001c1';
    const C2 = '00000000-0000-4000-8000-0000000001c2';
    const C3 = '00000000-0000-4000-8000-0000000001c3';
    const s2 = snap.buildBlueprintSnapshotV2(
      { id: cid, title: 'Curso R11', finalExam: true, activityEngine: 'h5p' },
      [{ id: M1, position: 0, title: 'M1', objective: null, exam_enabled: true }, { id: M2, position: 1, title: 'M2', objective: null, exam_enabled: false }],
      [{ id: C1, module_id: M1, position: 0, title: 'C1', objective: null, video_enabled: true, activity_enabled: true },
        { id: C2, module_id: M1, position: 1, title: 'C2', objective: null, video_enabled: false, activity_enabled: true },
        { id: C3, module_id: M2, position: 0, title: 'C3', objective: null, video_enabled: true, activity_enabled: false }],
    );
    for (const m of s2.modules) {
      await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
      for (const c of m.chapters) {
        await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, $6, $7)`,
          [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
      }
    }
    await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
                    values ($1, 1, 2, $2::jsonb, $3, 0, 2, 3)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const { manifest: dto } = await manifests.getOrCreate(cid, OWNER, 1);
    assert(dto.rulesVersion === 3, 'Manifest no v3');
    const [job] = await ds.query(
      `insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, input_payload)
       values ($1, $2, 'dynamic_generation', 'queued', 'queued', $3::jsonb) returning id`,
      [OWNER, cid, JSON.stringify({ manifestId: String(dto.id), blueprintNumber: 1 })]);
    let n = 0;
    for (const it of dto.manifest.items) {
      n += 1;
      await ds.query(
        `insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id, depends_on, idempotency_key, status)
         values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9::text[], $10, 'pending')`,
        [job.id, cid, dto.blueprintId, dto.id, it.key, it.type, it.moduleId, it.chapterId, it.dependsOn, String(n).padStart(64, 's')]);
    }
    const ctx = { courseName: 'Curso R11' };
    await ds.query(`insert into public.generation_run_contexts (job_id, manifest_id, context, context_hash) values ($1, $2, $3::jsonb, $4)`,
      [job.id, dto.id, JSON.stringify(ctx), canonicalContextHash(ctx)]);
    // Dependencias LLM "a mano": plan y contenidos completados.
    await ds.query(`update public.generation_item_runs set status = 'completed' where job_id = $1 and type in ('course_plan', 'content')`, [job.id]);

    const runsStub = {
      async tx(fn) {
        const qr = ds.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try { const out = await fn(qr); await qr.commitTransaction(); return out; }
        catch (e) { if (qr.isTransactionActive) await qr.rollbackTransaction(); throw e; }
        finally { await qr.release(); }
      },
      async reconcileCancellation() {},
    };
    const store = new Map();
    const reads = [];
    const reader = { async readText(a) { reads.push(a.type); if (!store.has(a.storagePath)) throw new Error('objeto inexistente'); return store.get(a.storagePath); } };
    const sched = new SchedulerService(ds, runsStub, reader);
    let seq = 0;
    const upload = async (type, content) => {
      seq += 1;
      const p = `r11/${type}/${seq}`;
      store.set(p, typeof content === 'string' ? content : JSON.stringify(content));
      return (await ds.query(`insert into public.artifacts (owner_id, course_id, type, storage_path) values ($1, $2, $3, $4) returning id`, [OWNER, String(cid), type, p]))[0].id;
    };
    const item = async (key) => (await ds.query(`select * from public.generation_item_runs where job_id = $1 and item_key = $2`, [job.id, key]))[0];
    const linked = async (id) => (await ds.query(`select item_run_id from public.artifacts where id = $1`, [id]))[0].item_run_id;
    // El ejecutor v3 real reclama siempre con su lista completa (R4: un claim sin
    // ningún tipo v3 sobre un run v3 → 409); acá se agrega video_interactions, que
    // no es reclamable hasta que su video esté completo.
    const V3_TYPES = ['experience', 'video_interactions', 'activity', 'final_exam'];
    const claim = (types) => sched.claimNextItem({
      executorId: 'b1', runId: job.id, ownerId: OWNER, leaseSeconds: 60,
      types: types.some((t) => V3_TYPES.includes(t)) ? types : [...types, 'video_interactions'],
    });
    const readyAgain = (key) => ds.query(`update public.generation_item_runs set next_retry_at = now() - interval '1 second' where job_id = $1 and item_key = $2`, [job.id, key]);

    await check('DB claim v3: experience/module_intro/final_exam/activity traen su bloque v3 (artifact validado, rotación, journey, rango)', async () => {
      const e = await claim(['experience']);
      eq([e.type, e.chapterId, e.claimPayload], ['experience', C1, { validatedArtifactType: 'dynamic_experience_json', chapterId: C1 }], 'experience');
      assert(e.dependencyArtifacts !== undefined, 'dependencyArtifacts');
      const mi = await claim(['module_intro']);
      eq([mi.type, mi.claimPayload.moduleChapterIds], ['module_intro', [C1, C2]], 'module_intro');
      const a = await claim(['activity']);
      eq([a.type, a.chapterId, a.variant, a.claimPayload.activityType, a.claimPayload.validatedArtifactType], ['activity', C1, 'h5p', 'questionset', 'dynamic_h5p_params_json'], 'activity C1');
      const a2 = await claim(['activity']);
      eq([a2.chapterId, a2.claimPayload.activityType], [C2, 'dragtext'], 'activity C2 (rotación)');
      const fe = await claim(['final_exam']);
      eq([fe.type, fe.claimPayload.finalExam], ['final_exam', { minQuestions: 5, maxQuestions: 40 }], 'final_exam');
    });

    await check('DB completeItem RECHAZA experience inválido: v3_payload_invalid + códigos, item → retrying con error, artifact sin vincular', async () => {
      const it = await item(`experience:${C1}`);
      const bad = F.experienceFor('otro-capitulo');
      bad.bridge_to_next = 'Sigue con el video del próximo tema.';
      const art = await upload('dynamic_experience_json', bad);
      const r = await sched.completeItemDetailed(it.id, 'b1', { artifactIds: [art], summary: {} }, OWNER);
      eq([r.ok, r.reason], [false, 'v3_payload_invalid'], 'resultado');
      assert(r.errors.includes('RESOURCE_MENTION') && r.errors.includes('CHAPTER_ID_MISMATCH'), `códigos ${r.errors}`);
      const after = await item(`experience:${C1}`);
      eq(after.status, 'retrying', 'status');
      assert(/^v3_payload_invalid: experience experience:/.test(after.error) && after.error.includes('RESOURCE_MENTION'), `error: ${after.error}`);
      eq(await linked(art), null, 'artifact vinculado');
    });

    await check('DB completeItem ACEPTA el experience válido tras reintento; output_summary.v3Validation', async () => {
      await readyAgain(`experience:${C1}`);
      const e = await claim(['experience']);
      eq(e.chapterId, C1, 'reclama el mismo');
      const art = await upload('dynamic_experience_json', F.experienceFor(C1));
      const r = await sched.completeItemDetailed(e.itemRunId, 'b1', { artifactIds: [art], summary: {} }, OWNER);
      eq(r, { ok: true }, 'completo');
      const after = await item(`experience:${C1}`);
      eq([after.status, after.output_summary.v3Validation.artifactType, after.output_summary.v3Validation.artifactId], ['completed', 'dynamic_experience_json', art], 'estado');
      // M7: huella sha256 del contenido validado (el empaque la verifica).
      const sha = require('crypto').createHash('sha256').update(JSON.stringify(F.experienceFor(C1)), 'utf8').digest('hex');
      eq(after.output_summary.v3Validation.contentSha256, sha, 'contentSha256 del contenido validado');
      eq(await linked(art), after.id, 'vinculado');
    });

    await check('DB activity h5p: tipo ≠ rotación → rechazo ACTIVITY_TYPE_MISMATCH; tipo correcto → completo', async () => {
      const it = await item(`activity:${C1}`);
      const r = await sched.completeItemDetailed(it.id, 'b1', { artifactIds: [await upload('dynamic_h5p_params_json', F.h5pPayload('dragtext'))], summary: {} }, OWNER);
      eq([r.ok, r.reason, r.errors], [false, 'v3_payload_invalid', ['ACTIVITY_TYPE_MISMATCH']], 'mismatch');
      await readyAgain(`activity:${C1}`);
      const a = await claim(['activity']);
      eq([a.chapterId, a.claimPayload.activityType], [C1, 'questionset'], 'reclamo');
      const ok = await sched.completeItemDetailed(a.itemRunId, 'b1', { artifactIds: [await upload('dynamic_h5p_params_json', F.h5pPayload('questionset'))], summary: {} }, OWNER);
      eq(ok, { ok: true }, 'completo');
      eq((await item(`activity:${C1}`)).output_summary.v3Validation.activityType, 'questionset', 'summary');
    });

    await check('DB module_intro: journey reordenado → JOURNEY_MISMATCH; final_exam: 3 preguntas → GIFT_QUESTION_COUNT, 12 → completo con questionCount', async () => {
      const mi = await item(`module_intro:${M1}`);
      const doc = { ...F.moduleIntroFixture({ modules: [{ chapters: [{ chapterId: C1 }, { chapterId: C2 }] }] }, 0) };
      const rev = clone(doc); rev.journey.reverse();
      const r = await sched.completeItemDetailed(mi.id, 'b1', { artifactIds: [await upload('dynamic_module_intro_json', rev)], summary: {} }, OWNER);
      eq([r.reason, r.errors], ['v3_payload_invalid', ['JOURNEY_MISMATCH']], 'journey');
      const fe = await item(`final_exam:${cid}`);
      const three = F.FINAL_GIFT.split('\n\n').slice(0, 3).join('\n\n');
      const r2 = await sched.completeItemDetailed(fe.id, 'b1', { artifactIds: [await upload('dynamic_exam_gift', three)], summary: {} }, OWNER);
      eq([r2.reason, r2.errors], ['v3_payload_invalid', ['GIFT_QUESTION_COUNT']], 'gift corto');
      await readyAgain(`final_exam:${cid}`);
      const again = await claim(['final_exam']);
      const ok = await sched.completeItemDetailed(again.itemRunId, 'b1', { artifactIds: [await upload('dynamic_exam_gift', F.FINAL_GIFT)], summary: {} }, OWNER);
      eq(ok, { ok: true }, 'final completo');
      eq((await item(`final_exam:${cid}`)).output_summary.v3Validation.questionCount, 12, 'questionCount medido');
    });

    await check('DB course_intro: QUANTITY_CLAIM rechazado; válido completo', async () => {
      const ci = await claim(['course_intro']);
      eq([ci.type, ci.claimPayload.validatedArtifactType], ['course_intro', 'dynamic_course_intro_json'], 'claim');
      const bad = F.courseIntroFixture(); bad.methodology_note = 'Son 3 módulos y 20 horas.';
      const r = await sched.completeItemDetailed(ci.itemRunId, 'b1', { artifactIds: [await upload('dynamic_course_intro_json', bad)], summary: {} }, OWNER);
      eq([r.reason, r.errors], ['v3_payload_invalid', ['DIGIT_IN_TEXT', 'FORBIDDEN_CLAIM', 'QUANTITY_CLAIM']], 'cantidad / cifras / horas');
      await readyAgain(`course_intro:${cid}`);
      const again = await claim(['course_intro']);
      eq(await sched.completeItemDetailed(again.itemRunId, 'b1', { artifactIds: [await upload('dynamic_course_intro_json', F.courseIntroFixture())], summary: {} }, OWNER), { ok: true }, 'válido');
    });

    await check('DB video_interactions: video sin duración/youtubeId → claim lo marca failed (no reintentable); con datos → plan R8 en el claim y validación contra la duración real', async () => {
      await ds.query(`update public.generation_item_runs set status = 'completed', output_summary = '{}'::jsonb where job_id = $1 and item_key = $2`, [job.id, `video:${C1}`]);
      await ds.query(`update public.generation_item_runs set status = 'completed', output_summary = $3::jsonb where job_id = $1 and item_key = $2`,
        [job.id, `video:${C3}`, JSON.stringify({ youtubeVideoId: 'IdwOipZAeqY', durationSec: 468, delivery: 'completed' })]);
      // Integración G2+G5: completar video_interactions registra la identidad del
      // video (R5 fix I3), que exige un artifact del video — como el que deja el
      // worker real al completar el item.
      const c3Video = await item(`video:${C3}`);
      const videoArt = await upload('dynamic_video', { youtubeVideoId: 'IdwOipZAeqY', durationSec: 468 });
      await ds.query(`update public.artifacts set item_run_id = $2 where id = $1`, [videoArt, c3Video.id]);
      // M6: el claim marca failed el item sin datos y SIGUE con el próximo candidato (no devuelve null).
      const v = await claim(['video_interactions']);
      const vi1 = await item(`video_interactions:${C1}`);
      assert(vi1.status === 'failed' && /claim_payload_unavailable: VIDEO_YOUTUBE_ID_MISSING/.test(vi1.error), `${vi1.status} ${vi1.error}`);
      assert(v, 'el claim devolvió null habiendo otro item reclamable');
      eq([v.chapterId, v.claimPayload.video.youtubeId, v.claimPayload.video.durationSec, v.claimPayload.video.checkpoints.map((c) => c.atSec)], [C3, 'IdwOipZAeqY', 468, [72, 157, 242, 326, 411]], 'claim con plan');
      const plan = v.claimPayload.video.checkpoints;
      const wrong = VF.makeInteractionsDoc(plan, { videoItemKey: `video:${C3}`, durationSec: 300 });
      const r = await sched.completeItemDetailed(v.itemRunId, 'b1', { artifactIds: [await upload('dynamic_video_interactions_json', wrong)], summary: {} }, OWNER);
      eq([r.reason, r.errors], ['v3_payload_invalid', ['H5P_INPUT_INVALID']], 'duración distinta');
      await readyAgain(`video_interactions:${C3}`);
      const again = await claim(['video_interactions']);
      const good = VF.makeInteractionsDoc(plan, { videoItemKey: `video:${C3}`, durationSec: 468 });
      eq(await sched.completeItemDetailed(again.itemRunId, 'b1', { artifactIds: [await upload('dynamic_video_interactions_json', good)], summary: {} }, OWNER), { ok: true }, 'válido');
      eq((await item(`video_interactions:${C3}`)).output_summary.v3Validation.interactionCount, 5, 'summary');
    });

    await check('DB sin lector configurado: un item v3 validable NO se completa (500 v3_validator_unavailable), sigue running', async () => {
      const noReader = new SchedulerService(ds, runsStub);
      const a = await noReader.claimNextItem({ executorId: 'b2', types: ['experience'], runId: job.id, ownerId: OWNER, leaseSeconds: 60 });
      assert(a && a.type === 'experience', 'sin experience reclamable');
      const art = await upload('dynamic_experience_json', F.experienceFor(a.chapterId));
      await rejectsRe(noReader.completeItemDetailed(a.itemRunId, 'b2', { artifactIds: [art], summary: {} }, OWNER), /v3_validator_unavailable/, 'sin lector', 500);
      eq((await item(a.itemKey)).status, 'running', 'sigue running');
      eq(await linked(art), null, 'no vinculado');
      // Lector que falla (storage caído) → 503 y el item sigue running (no es culpa del contenido).
      const flaky = new SchedulerService(ds, runsStub, { async readText() { throw new Error('storage caído'); } });
      await rejectsRe(flaky.completeItemDetailed(a.itemRunId, 'b2', { artifactIds: [art], summary: {} }, OWNER), /v3_artifact_unreadable/, 'lector caído', 503);
      eq((await item(a.itemKey)).status, 'running', 'sigue running tras 503');
    });

    await check('DB M5 (fail closed): item v3 validable cuya entrada falta del Manifest congelado → 500 v3_validation_context, sigue running', async () => {
      const a = await claim(['experience']);
      assert(a && a.type === 'experience', 'sin experience reclamable');
      // El Manifest es inmutable (trigger): se simula la integridad rota renombrando la clave del item run.
      await ds.query(`update public.generation_item_runs set item_key = $2 where id = $1`, [a.itemRunId, `${a.itemKey}-roto`]);
      try {
        const art = await upload('dynamic_experience_json', F.experienceFor(a.chapterId));
        await rejectsRe(sched.completeItemDetailed(a.itemRunId, 'b1', { artifactIds: [art], summary: {} }, OWNER), /v3_validation_context/, 'sin entrada del Manifest', 500);
        eq((await item(`${a.itemKey}-roto`)).status, 'running', 'sigue running');
      } finally {
        await ds.query(`update public.generation_item_runs set item_key = $2 where id = $1`, [a.itemRunId, a.itemKey]);
      }
      const art2 = await upload('dynamic_experience_json', F.experienceFor(a.chapterId));
      eq(await sched.completeItemDetailed(a.itemRunId, 'b1', { artifactIds: [art2], summary: {} }, OWNER), { ok: true }, 'con el Manifest restaurado completa');
    });

    await check('DB guards de siempre intactos: executor ajeno → lease_lost sin validar; artifact ya validado cambiado → rechazo', async () => {
      const a = await claim(['module_intro']);
      assert(a && a.type === 'module_intro', 'sin module_intro reclamable');
      const miDoc = F.moduleIntroFixture({ modules: [{ chapters: a.claimPayload.moduleChapterIds.map((chapterId) => ({ chapterId })) }] }, 0);
      const art = await upload('dynamic_module_intro_json', miDoc);
      const before = reads.length;
      eq(await sched.completeItemDetailed(a.itemRunId, 'otro', { artifactIds: [art], summary: {} }, OWNER), { ok: false, reason: 'lease_lost' }, 'executor ajeno');
      eq(reads.length, before, 'leyó el artifact de un executor ajeno');
      // El objeto cambia de ruta entre la validación y la transacción → rechazo, nada vinculado.
      const swapper = new SchedulerService(ds, runsStub, {
        async readText(ref) {
          const text = store.get(ref.storagePath);
          await ds.query(`update public.artifacts set storage_path = storage_path || '-swapped' where id = $1`, [ref.id]);
          return text;
        },
      });
      eq(await swapper.completeItemDetailed(a.itemRunId, 'b1', { artifactIds: [art], summary: {} }, OWNER), { ok: false, reason: 'artifact_changed_after_validation' }, 'artifact cambiado');
      eq([(await item(a.itemKey)).status, await linked(art)], ['running', null], 'sigue running y sin vincular');
      const art2 = await upload('dynamic_module_intro_json', miDoc);
      eq(await sched.completeItemDetailed(a.itemRunId, 'b1', { artifactIds: [art2], summary: {} }, OWNER), { ok: true }, 'completo');
    });
  } finally {
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    for (const [k, v] of Object.entries({ DYNAMIC_COURSE_STRUCTURE: saved.flag, DYNAMIC_V2_ALLOWED_OWNERS: saved.allow, DYNAMIC_MANIFEST_RULES_VERSION: saved.rules, ALLOW_UNOWNED_COURSES: saved.unowned })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    console.log('PG16 descartable destruido');
  }
}

(async () => {
  await pureChecks();
  if (PURE_ONLY) {
    console.log('ℹ️  --pure-only: parte DB (PG16 desechable) NO ejecutada');
  } else {
    try {
      await dbChecks();
    } catch (err) {
      failures++;
      console.error(`❌ setup de la parte DB falló: ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures > 0 ? 1 : 0);
})();
