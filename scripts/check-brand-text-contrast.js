#!/usr/bin/env node
/* eslint-disable */
// Fix #542 (staging, 2026-10-01) — texto en color de marca / rol / módulo legible POR CONSTRUCCIÓN.
//
// Incidente: curso real #542 (Aula Clara light + paleta «Púrpura Nocturno») → el paquete fallaba
// siempre con `SHELL_RENDER: Qué aprenderás: no pasa CLEAN_SAFE: LOW_CONTRAST #BD0AD8 sobre #F4E3F7`:
// el rótulo ENHANCED («píldora» con fondo tintado) elegía su tinta contra la superficie del bloque y
// no contra la píldora sobre la que de verdad se pinta.
//
// Este check (puro, sin DB, sin red, sin proveedores):
//   1. brandTextInk(): devuelve la marca tal cual si ya cumple; si no, MISMO tono, oscurece en claro /
//      aclara en oscuro, el PRIMER paso que alcanza 4.5:1 contra todos los fondos; determinista.
//   2. El caso exacto #542: competenciesLabel ENHANCED en aula-clara/light + nocturno ya no lanza y su
//      rótulo usa una tinta derivada del mismo tono de #BD0AD8 (no el gris del texto).
//   3. Matriz: 7 familia×modo × (sin semilla + 28 paletas predefinidas + marcas adversariales) ×
//      {CLEAN_SAFE, ENHANCED}: todos los labels del shell (cursos de 2 y 4 módulos), todos los capítulos
//      ensamblados y todos los componentes (sin módulo y con 5 colores de módulo; apertura; shell
//      countless) pasan lintCleanSafe SIN LOW_CONTRAST, y en el <style> ENHANCED toda regla que fija
//      `background-color` y `color` hex en el mismo bloque Y se aplica a algo del label alcanza 4.5:1.
//
// Usage: node scripts/check-brand-text-contrast.js [path/to/dist]   (requiere `npm run build`)

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
const te = loadDist('modules/theme-engine/index.js');
const vc = loadDist('modules/visual-components/index.js');
const S = loadDist('modules/course-shell/index.js');
const cp = loadDist('modules/course-profiles/course-profiles.js');
const F = require('./lib/v21-shell-fixtures');
const VCF = require('./lib/v21-vc-fixtures');
const cm = loadDist('modules/theme-engine/color-math.js');

let passes = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message.split('\n').join('\n   ') : err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Marcas adversariales: amarillo muy claro, magenta medio (#542), cian medio, gris medio, casi blanco/negro…
const ADVERSARIAL = ['#BD0AD8', '#FFF59D', '#FFFF00', '#00BCD4', '#22D3EE', '#E879F9', '#808080', '#F5F5F5', '#1A1A1A', '#FF6600', '#7FFF00'];
const SEEDS = [{ id: 'sin-semilla', seed: undefined }];
for (const p of te.LEGACY_PALETTES) SEEDS.push({ id: p.id, seed: te.brandSeedFromLegacyPalette(p) });
for (const a of ADVERSARIAL) SEEDS.push({ id: `custom-${a}`, seed: { accent: a, moduleColors: [a, '#FFF59D', '#00BCD4'] } });

const hueDist = (a, b) => {
  const d = Math.abs(cm.hexToHsl(a).h - cm.hexToHsl(b).h) % 360;
  return d > 180 ? 360 - d : d;
};

// ─── 1. brandTextInk ────────────────────────────────────────────────────────
check('brandTextInk: marca que ya cumple → la misma cadena, sin normalizar', () => {
  assert(te.brandTextInk('#1A237E', ['#FBFBF9']) === '#1A237E', 'debe devolver la marca');
  assert(te.brandTextInk('#1a237e', ['#FBFBF9']) === '#1a237e', 'no debe normalizar si ya cumple');
});
check('brandTextInk: #BD0AD8 sobre #F4E3F7 → mismo tono, oscurecida, ≥ 4.5:1, paso mínimo', () => {
  const ink = te.brandTextInk('#BD0AD8', ['#F4E3F7']);
  assert(ink !== '#BD0AD8', 'debió derivar una tinta');
  assert(te.contrastRatio(ink, '#F4E3F7') >= 4.5, `${ink} no alcanza 4.5`);
  assert(hueDist(ink, '#BD0AD8') < 3, `tono distinto: ${ink}`);
  assert(te.relativeLuminance(ink) < te.relativeLuminance('#BD0AD8'), 'debió oscurecer');
  const { h, s, l } = cm.hexToHsl('#BD0AD8');
  const lInk = cm.hexToHsl(ink).l;
  const prev = cm.hslToHex(h, s, lInk + 0.01);
  assert(te.contrastRatio(prev, '#F4E3F7') < 4.5 || prev === '#BD0AD8', `no es el paso mínimo (${prev} ya cumplía)`);
  assert(Math.abs(lInk - l) < 0.15, `cambio excesivo: L ${l.toFixed(3)} → ${lInk.toFixed(3)}`);
});
check('brandTextInk: fondos oscuros → aclara (mismo tono); varios fondos → cumple contra todos', () => {
  const ink = te.brandTextInk('#3B0764', ['#0A021A', '#1A1030']);
  assert(te.relativeLuminance(ink) > te.relativeLuminance('#3B0764'), 'debió aclarar');
  assert(te.contrastRatio(ink, '#0A021A') >= 4.5 && te.contrastRatio(ink, '#1A1030') >= 4.5, 'no cumple contra todos');
  assert(hueDist(ink, '#3B0764') < 4, `tono distinto: ${ink}`);
  const y = te.brandTextInk('#FFF59D', ['#FBFBF9', '#F4F1E6']);
  assert(te.contrastRatio(y, '#FBFBF9') >= 4.5 && te.contrastRatio(y, '#F4F1E6') >= 4.5, `amarillo claro no cumple: ${y}`);
  assert(te.brandTextInk('#00BCD4', ['#FBFBF9']) === te.brandTextInk('#00BCD4', ['#FBFBF9']), 'determinista');
});
check('brandTextInk: sin fondos → THEME_INVALID (falla fuerte)', () => {
  let msg = '';
  try { te.brandTextInk('#BD0AD8', []); } catch (e) { msg = e.message; }
  assert(/THEME_INVALID/.test(msg), 'debió lanzar');
});

// ─── 2. El caso exacto del incidente ────────────────────────────────────────
const C2 = F.course2(distRoot);
const C4 = F.course4(distRoot);
const factsOf = (course) =>
  S.buildCourseFacts({
    manifest: course.manifest,
    blueprint: course.snapshot,
    assessment: cp.defaultAssessmentProfile({ finalExam: course.manifest.features.finalExam }),
    artifacts: F.measuredArtifacts(course.manifest),
  });
const COURSES = [{ course: C2, facts: factsOf(C2) }, { course: C4, facts: factsOf(C4) }];
const CI = F.courseIntroFixture();

check('#542: Aula Clara light + Púrpura Nocturno → «Qué aprenderás» ENHANCED y CLEAN_SAFE pasan; rótulo en tinta del tono de marca', () => {
  const nocturno = te.LEGACY_PALETTES.find((p) => p.id === 'nocturno');
  const theme = te.resolveTheme({ themeFamily: 'aula-clara', mode: 'light', brandSeed: te.brandSeedFromLegacyPalette(nocturno) });
  assert(theme.color.accentStrong === '#BD0AD8' && theme.color.accentSoft === '#F4E3F7', `precondición: tokens del incidente (${theme.color.accentStrong}/${theme.color.accentSoft})`);
  for (const level of [undefined, 'enhanced']) {
    const lbl = S.competenciesLabel(COURSES[0].facts, CI, theme, level ? { level } : undefined);
    const lint = vc.lintCleanSafe(lbl.html);
    assert(lint.ok, `${level || 'clean'}: ${lint.errors.slice(0, 2).map((e) => e.code + ' ' + e.message).join('; ')}`);
    const m = lbl.html.match(/<p class="cvc-meta cvc-chip" style="[^"]*?color:(#[0-9A-F]{6})/);
    assert(m, 'sin rótulo');
    if (level) {
      assert(m[1] !== '#BD0AD8', 'ENHANCED: el rótulo sigue en #BD0AD8 sobre la píldora');
      assert(te.contrastRatio(m[1], '#F4E3F7') >= 4.5, `ENHANCED: ${m[1]} sobre #F4E3F7 < 4.5`);
      assert(hueDist(m[1], '#BD0AD8') < 3, `ENHANCED: la tinta ${m[1]} no conserva el tono de marca`);
    } else {
      assert(m[1] === '#BD0AD8', `CLEAN_SAFE ya pasaba: debe quedar en #BD0AD8 (quedó ${m[1]})`);
    }
  }
});

// ─── 3. Matriz ──────────────────────────────────────────────────────────────
const HEX = /^#[0-9a-fA-F]{6}$/;
/**
 * Reglas del <style> que fijan background-color y color hex en el MISMO bloque y que de verdad se
 * aplican a algo del label: toda clase del selector (incluido el scope `.cvc-<uid>`) debe aparecer en el
 * markup. (El <style> compartido trae reglas para piezas que un label puede no tener; esas no pintan texto.)
 */
function cssPairs(html) {
  const out = [];
  const markup = html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  const classes = new Set();
  for (const m of markup.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).forEach((c) => c && classes.add(c));
  const styles = html.match(/<style>[\s\S]*?<\/style>/g) || [];
  for (const st of styles) {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(st))) {
      const body = m[2];
      const bg = (body.match(/(?:^|;)\s*background-color:\s*(#[0-9a-fA-F]{6})/) || [])[1];
      const fg = (body.match(/(?:^|;)\s*color:\s*(#[0-9a-fA-F]{6})/) || [])[1];
      if (!bg || !fg) continue;
      const applies = m[1].split(',').some((sel) => {
        // `.cvc-js` la agrega el runtime al cargar: cuenta como presente.
        const cls = [...sel.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((x) => x[1]).filter((c) => c !== 'cvc-js');
        return cls.every((c) => classes.has(c));
      });
      if (applies) out.push({ sel: m[1].trim().slice(-60), bg, fg });
    }
  }
  return out;
}

const matrixFailures = [];
let renders = 0;
let cssRules = 0;
function lintOne(key, html) {
  renders++;
  const lint = vc.lintCleanSafe(html);
  const low = lint.errors.filter((e) => e.code === 'LOW_CONTRAST');
  if (low.length) matrixFailures.push(`${key}: ${low[0].message}`);
  for (const p of cssPairs(html)) {
    cssRules++;
    const r = te.contrastRatio(p.fg, p.bg);
    if (r < 4.5) matrixFailures.push(`${key}: <style> ${p.sel} ${p.fg} sobre ${p.bg} = ${r.toFixed(2)}:1`);
  }
}

function shellLabels(course, facts, theme, o) {
  const L = S.sectionLayoutFromFacts(facts);
  const first = L.moduleFirstSection[facts.modules[0].id];
  const xs = [
    ['bienvenida', () => S.welcomeLabel(facts, CI, theme, o)],
    ['bienvenida-qa', () => S.welcomeLabel(facts, CI, theme, o, true)],
    ['audio', () => S.audioWelcomeLabel(facts, theme, o)],
    ['competencias', () => S.competenciesLabel(facts, CI, theme, o)],
    ['metodologia', () => S.methodologyLabel(facts, CI, theme, o)],
    ['ruta', () => S.routeLabel(facts, theme, o)],
    ['libro', () => S.libroCardLabel(77, facts, theme, o)],
    ['audiolibro', () => S.audiobookLabel(facts, theme, o)],
    ['cierre', () => S.closingLabel(facts, CI, theme, o)],
    ['inicio', () => S.welcomeStartLabel(first, facts, theme, o)],
    ['ruta-inicio', () => S.routeStartLabel(first, facts, theme, o)],
    ['examenes-docente', () => S.examsTeacherLabel(facts, theme, o)],
    ['certificado-docente', () => S.certificateTeacherLabel('Certificado: Curso', facts, theme, o)],
  ];
  if (facts.finalExam.enabled) {
    xs.push(
      ['cierre-cert', () => S.closingLabel(facts, CI, theme, o, { activities: true, videos: true, moduleExams: true, finalExam: true, courseGrade: false })],
      ['final-info', () => S.finalExamInfoLabel(facts, theme, o)],
      ['final-next', () => S.finalExamNextLabel(L.closingSection, facts, theme, o)],
    );
  }
  facts.modules.forEach((m, i) => {
    xs.push([`modulo${i}`, () => S.moduleIntroLabel(m, F.moduleIntroFixture(course.manifest, i), facts, theme, o)]);
    if (m.examEnabled) {
      const nx = facts.modules[i + 1];
      xs.push([`examen${i}`, () => S.examInfoLabel(m, facts, theme, o)]);
      xs.push([`siguiente${i}`, () => S.moduleNextLabel(m, nx ? { kind: 'module', module: nx, sectionNum: L.moduleFirstSection[nx.id] } : { kind: 'closing', sectionNum: L.finalExamSection ?? L.closingSection }, facts, theme, o)]);
    }
  });
  return xs;
}

const COMPONENTS = [
  ...VCF.loadComponents(),
  { type: 'learning_objectives', title: 'Qué aprenderás', items: ['Uno claro', 'Dos claro', 'Tres claro', 'Cuatro claro'] },
];
const OPENER = { kicker: 'Capítulo 1', title: 'Apertura', numeral: '1', progress: 'Módulo 1 · Capítulo 1', minutes: 12 };

check(`matriz: ${VCF.THEME_COMBOS.length} familia×modo × ${SEEDS.length} semillas (28 paletas + adversariales) × 2 niveles → cero LOW_CONTRAST (inline y <style>)`, () => {
  assert(te.LEGACY_PALETTES.length === 28, `se esperaban 28 paletas predefinidas (hay ${te.LEGACY_PALETTES.length})`);
  for (const combo of VCF.THEME_COMBOS) {
    for (const sd of SEEDS) {
      const theme = te.resolveTheme({ ...combo, brandSeed: sd.seed });
      for (const level of [undefined, 'enhanced']) {
        const tag = `${combo.themeFamily}-${combo.mode}/${sd.id}/${level || 'clean'}`;
        const o = level ? { level } : undefined;
        COURSES.forEach(({ course, facts }, cx) => {
          for (const [name, fn] of shellLabels(course, facts, theme, o)) {
            let lbl;
            try { lbl = fn(); } catch (e) { matrixFailures.push(`${tag}/c${cx}/${name}: ${e.message.slice(0, 200)}`); continue; }
            lintOne(`${tag}/c${cx}/${name}`, lbl.html);
          }
          let chapters;
          try { chapters = S.assembleAllChapters(facts, F.experiencesFor(course.manifest), theme, o); } catch (e) { matrixFailures.push(`${tag}/c${cx}/capítulos: ${e.message.slice(0, 200)}`); return; }
          chapters.forEach((ch) => ch.slots.forEach((sl, si) => {
            if (sl && typeof sl.html === 'string') {
              lintOne(`${tag}/c${cx}/cap${ch.chapterNumber}/${si}`, sl.html);
            }
          }));
        });
        const mods = [undefined, ...[0, 1, 2, 3, 4].map((i) => te.moduleColor(theme, i))];
        COMPONENTS.forEach((c, i) => {
          mods.forEach((module, mi) => {
            const key = `${tag}/${VCF.fixtureName(c)}#${i}/m${mi}`;
            try {
              lintOne(key, vc.renderMovement([c], theme, { uid: 'bt', level, module }));
              if (c.type === 'hero') lintOne(key + '/apertura', vc.renderComponent(c, theme, { uid: 'bt', level, module, opener: OPENER }));
              if (c.type === 'learning_objectives') lintOne(key + '/shell', vc.renderComponent(c, theme, { uid: 'bt', level, module, countless: true }));
            } catch (e) {
              matrixFailures.push(`${key}: ${e.message.slice(0, 200)}`);
            }
          });
        });
      }
    }
  }
  assert(renders > 100000, `cobertura insuficiente (${renders} renders)`);
  assert(matrixFailures.length === 0, `${matrixFailures.length} fallas en ${renders} renders:\n${matrixFailures.slice(0, 12).join('\n')}`);
  assert(cssRules > 10000, `cobertura de reglas <style> insuficiente (${cssRules})`);
  console.log(`   ${renders} renders y ${cssRules} pares fondo/texto de <style> sin LOW_CONTRAST`);
});

console.log(`\n${passes} ok, ${failures} fallas`);
process.exit(failures ? 1 : 0);
