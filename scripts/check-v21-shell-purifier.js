#!/usr/bin/env node
/* eslint-disable */
// R11a (Cursia V2.1) — labels del Course Shell y del capítulo contra el
// purificador REAL de Moodle (purify_html, forceclean=1) vía PHP CLI de solo
// lectura (scripts/lib/moodle-purify.php de R2; sin tocar la configuración del
// sitio ni sus datos).
//
// Casos: todos los labels del shell (bienvenida, audio, competencias,
// metodología, ruta, Libro, audiolibro, presentación de módulo, info de
// examen, examen final, cierre) y todos los labels de capítulo (movimientos +
// transiciones) de dos cursos (2 y 4 módulos, las 4 combinaciones V/A) × 7
// temas × {CLEAN_SAFE, ENHANCED}. Los tokens de Moodle se sustituyen por URLs
// reales como lo hace Moodle antes de format_text (pluginfile / view.php).
//
// Exige:
//   - extractText(purificado) === extractText(original)  → 100 % del texto;
//   - lintCleanSafe(purificado) pasa;
//   - nada de la capa ENHANCED sobrevive (<style>/<script>/<details>/aria/display);
//   - CLEAN_SAFE: el purificador no descarta NINGUNA declaración inline;
//   - el <audio> (src) y los enlaces (Libro, descarga MP3) sobreviven;
//   - ENHANCED purificado ≡ CLEAN_SAFE purificado en texto.
//
// Requiere dist/ (npm run build) y el Moodle local (Postgres en marcha). Falla fuerte si no.
// Uso: node scripts/check-v21-shell-purifier.js

const path = require('path');
const F = require('./lib/v21-shell-fixtures');
const { purifyMany, moodleFormat, MOODLE_CONFIG } = require('./lib/v21-moodle-purify');

let S, vc, te, cp, P;
try {
  P = require(path.resolve(process.cwd(), 'dist/package/presentation/index.js'));
  S = require(path.resolve(process.cwd(), 'dist/modules/course-shell/index.js'));
  vc = require(path.resolve(process.cwd(), 'dist/modules/visual-components/index.js'));
  te = require(path.resolve(process.cwd(), 'dist/modules/theme-engine/index.js'));
  cp = require(path.resolve(process.cwd(), 'dist/modules/course-profiles/course-profiles.js'));
} catch (err) {
  console.error('❌ No se pudo cargar dist/ (¿corriste "npm run build"?)');
  console.error(`   ${err.message}`);
  process.exit(1);
}
const DIST = path.resolve(process.cwd(), 'dist');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const WWW = 'http://127.0.0.1:8099';
/** Lo que Moodle hace antes de format_text: tokens de restore y pluginfile → URLs reales. */
function resolveTokens(html) {
  return html
    .replace(/@@PLUGINFILE@@/g, `${WWW}/pluginfile.php/4242/mod_label/intro`)
    .replace(/\$@RESOURCEVIEWBYID\*(\d+)@\$/g, (_m, id) => `${WWW}/mod/resource/view.php?id=${id}`);
}

function factsOf(course, hours) {
  return S.buildCourseFacts({
    manifest: course.manifest,
    blueprint: course.snapshot,
    assessment: cp.defaultAssessmentProfile({ finalExam: course.manifest.features.finalExam }),
    artifacts: F.measuredArtifacts(course.manifest),
    hours,
  });
}

// ─── Casos ──────────────────────────────────────────────────────────────────
const cases = [];
const courses = [
  ['c2', F.course2(DIST), 40],
  ['c4', F.course4(DIST), undefined],
];
for (const combo of F.THEME_COMBOS) {
  const theme = te.resolveTheme(combo);
  const tl = F.themeLabel(combo);
  for (const [cname, course, hours] of courses) {
    const facts = factsOf(course, hours);
    const ci = F.courseIntroFixture();
    for (const level of [undefined, 'enhanced']) {
      const o = level ? { level } : undefined;
      const labels = [
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
        labels.push(S.moduleIntroLabel(m, F.moduleIntroFixture(course.manifest, i), facts, theme, o));
        if (m.examEnabled) labels.push(S.examInfoLabel(m, facts, theme, o));
      });
      if (facts.finalExam.enabled) labels.push(S.finalExamInfoLabel(facts, theme, o));
      for (const { slots } of S.assembleAllChapters(facts, F.experiencesFor(course.manifest), theme, o)) {
        for (const s of slots) if (s.kind === 'label') labels.push(s);
      }
      // I4: la tarjeta de Gamma también pasa por el purificador real.
      facts.chapters.forEach((ch) => {
        labels.push({
          name: `Capítulo ${ch.number} · Presentación`,
          html: P.presentationCardHtml({ chapterNumber: ch.number, chapterTitle: ch.title, coverUrl: `@@PLUGINFILE@@/cap${ch.number}_portada.png`, pdfUrl: `@@PLUGINFILE@@/cap${ch.number}_presentacion.pdf`, slideCount: ch.slideCount, theme, moduleColor: te.moduleColor(theme, ch.moduleNumber - 1), level }),
        });
      });
      for (const l of labels) {
        cases.push({ name: `${tl}/${cname}/${l.name}/${level || 'clean'}`, key: `${tl}/${cname}/${l.name}`, level, html: resolveTokens(l.html) });
      }
    }
  }
}

let purified;
try {
  purified = purifyMany(cases.map((c) => c.html));
} catch (err) {
  console.error(`❌ purify_html() del Moodle local no disponible (${MOODLE_CONFIG})`);
  console.error(`   ${err.message}`);
  process.exit(1);
}

function propsCount(html) {
  const counts = {};
  const walk = (el) => {
    if (el.kind !== 'el') return;
    for (const d of vc.parseStyle(el.attrs.style)) counts[`${el.tag}:${d.prop}`] = (counts[`${el.tag}:${d.prop}`] || 0) + 1;
    el.children.forEach(walk);
  };
  walk(vc.parseHtml(html));
  return counts;
}

function attrValues(html, tag, attr) {
  const out = [];
  const walk = (el) => {
    if (el.kind !== 'el') return;
    if (el.tag === tag && el.attrs[attr] !== undefined) out.push(el.attrs[attr]);
    el.children.forEach(walk);
  };
  walk(vc.parseHtml(html));
  return out;
}

check(`purify_html real disponible y devuelve ${cases.length} resultados`, () => {
  assert(purified.length === cases.length, 'cantidad');
  assert(purified.every((p) => typeof p === 'string' && p.length > 0), 'resultado vacío');
  assert(cases.length > 500, `pocos casos (${cases.length})`);
});

check('100 % del texto sobrevive forceclean (extractText idéntico) en todos los labels', () => {
  const bad = [];
  cases.forEach((c, i) => {
    const a = vc.extractText(c.html);
    const b = vc.extractText(purified[i]);
    if (a !== b) {
      let k = 0;
      while (a[k] === b[k]) k++;
      bad.push(`${c.name}: difiere en ${k}: «${a.slice(Math.max(0, k - 30), k + 40)}» vs «${b.slice(Math.max(0, k - 30), k + 40)}»`);
    }
  });
  assert(bad.length === 0, `${bad.length} casos:\n   ${bad.slice(0, 5).join('\n   ')}`);
});

check('lintCleanSafe pasa sobre el HTML purificado en todos los labels', () => {
  const bad = [];
  cases.forEach((c, i) => {
    const r = vc.lintCleanSafe(purified[i]);
    if (!r.ok) bad.push(`${c.name}: ${JSON.stringify(r.errors.slice(0, 2))}`);
  });
  assert(bad.length === 0, `${bad.length} casos:\n   ${bad.slice(0, 5).join('\n   ')}`);
});

check('el purificado no conserva la capa ENHANCED (<style>, <script>, <details>, aria, data-, display, radius)', () => {
  cases.forEach((c, i) => {
    const p = purified[i];
    for (const bad of ['<style', '<script', '<details', '<summary', 'aria-', 'data-cvc', 'display:', 'border-radius', 'box-shadow', 'clamp(']) {
      assert(!p.includes(bad), `${c.name}: "${bad}" sobrevivió a forceclean`);
    }
  });
});

check('CLEAN_SAFE: el purificador no descarta ninguna declaración inline', () => {
  cases
    .map((c, i) => [c, i])
    .filter(([c]) => !c.level)
    .forEach(([c, i]) => {
      const a = propsCount(c.html);
      const b = propsCount(purified[i]);
      for (const [prop, n] of Object.entries(a)) {
        assert(b[prop] === n, `${c.name}: "${prop}" ${n} → ${b[prop] || 0} tras purificar`);
      }
    });
});

check('<audio> y enlaces (Libro Guía, descarga MP3) sobreviven con su URL', () => {
  let audios = 0;
  let libro = 0;
  cases.forEach((c, i) => {
    const srcBefore = attrValues(c.html, 'audio', 'src');
    const srcAfter = attrValues(purified[i], 'audio', 'src');
    assert(JSON.stringify(srcBefore) === JSON.stringify(srcAfter), `${c.name}: audio src ${JSON.stringify(srcBefore)} → ${JSON.stringify(srcAfter)}`);
    audios += srcAfter.length;
    const hrefBefore = attrValues(c.html, 'a', 'href');
    const hrefAfter = attrValues(purified[i], 'a', 'href').map((h) => h.replace(/&amp;/g, '&'));
    assert(JSON.stringify(hrefBefore) === JSON.stringify(hrefAfter), `${c.name}: href ${JSON.stringify(hrefBefore)} → ${JSON.stringify(hrefAfter)}`);
    if (hrefAfter.some((h) => h.includes('/mod/resource/view.php?id=77'))) libro += 1;
  });
  assert(audios > 0 && libro > 0, `sin audios (${audios}) o sin enlace al Libro (${libro})`);
});

check('ENHANCED purificado ≡ CLEAN_SAFE purificado en texto (misma información en ambos niveles)', () => {
  const idx = new Map();
  cases.forEach((c, i) => idx.set(`${c.key}/${c.level || 'clean'}`, i));
  for (const c of cases.filter((x) => x.level === 'enhanced')) {
    const j = idx.get(`${c.key}/clean`);
    assert(j !== undefined, `par CLEAN_SAFE de ${c.name}`);
    assert(vc.extractText(purified[idx.get(`${c.key}/enhanced`)]) === vc.extractText(purified[j]), `${c.name}: texto distinto al CLEAN_SAFE`);
  }
});

// ─── I7: filtros de Moodle (format_text real: activitynames, emoticon, urltolink…) ─────────
// Títulos del Blueprint = nombres REALES de actividades del curso de contexto + emoticones:
// sin `nolink` los filtros los enlazarían/reemplazarían. Se exige que no se inyecte nada.
let probe = null;
try {
  probe = moodleFormat({ mode: 'probe' });
} catch (err) {
  failures += 1;
  console.error(`❌ format_text() del Moodle local no disponible: ${err.message}`);
}
if (probe) {
  const [n1, n2] = probe.names;
  const trig = (base) => `${base} ${n1} :-) (y)`;
  const course = F.buildCourse(DIST, {
    courseId: 520, title: trig('Curso'), finalExam: true,
    chapterTitles: [trig('Escucha'), n2 || n1, trig('Reclamos')], moduleTitles: [trig('Bases'), n1],
    modules: [
      { examEnabled: true, chapters: [{ video: true, activity: true }, { video: false, activity: false }] },
      { examEnabled: false, chapters: [{ video: true, activity: false }] },
    ],
  });
  const facts = factsOf(course, 12);
  const fcases = [];
  for (const combo of [F.THEME_COMBOS[0], F.THEME_COMBOS[6]]) {
    const theme = te.resolveTheme(combo);
    for (const level of [undefined, 'enhanced']) {
      const o = level ? { level } : undefined;
      const ci = F.courseIntroFixture();
      const ls = [
        S.welcomeLabel(facts, ci, theme, o), S.audioWelcomeLabel(facts, theme, o), S.competenciesLabel(facts, ci, theme, o),
        S.methodologyLabel(facts, ci, theme, o), S.routeLabel(facts, theme, o), S.libroCardLabel(77, facts, theme, o),
        S.audiobookLabel(facts, theme, o), S.closingLabel(facts, ci, theme, o), S.finalExamInfoLabel(facts, theme, o),
      ];
      facts.modules.forEach((m, i) => {
        ls.push(S.moduleIntroLabel(m, F.moduleIntroFixture(course.manifest, i), facts, theme, o));
        if (m.examEnabled) ls.push(S.examInfoLabel(m, facts, theme, o));
      });
      for (const { slots } of S.assembleAllChapters(facts, F.experiencesFor(course.manifest), theme, o)) for (const s of slots) if (s.kind === 'label') ls.push(s);
      facts.chapters.forEach((ch) => ls.push({ name: `card ${ch.number}`, html: P.presentationCardHtml({ chapterNumber: ch.number, chapterTitle: ch.title, coverUrl: 'c.png', pdfUrl: 'p.pdf', slideCount: ch.slideCount, theme, moduleColor: te.moduleColor(theme, 0), level }) }));
      for (const l of ls) fcases.push({ name: `${F.themeLabel(combo)}/${level || 'clean'}/${l.name}`, html: resolveTokens(l.html) });
    }
  }
  const unprotected = fcases[0].html.split('<span class="nolink">').join('<span>');
  const out = moodleFormat({ mode: 'format', cmid: probe.cmid, items: [...fcases.map((c) => c.html), unprotected] });
  const tagCount = (h, t) => (h.match(new RegExp(`<${t}[\\s>]`, 'gi')) || []).length;
  check(`filtros: control — sin nolink, el label SÍ se filtra (curso ${probe.courseid}, cm ${probe.cmid})`, () => {
    for (const v of ['noclean', 'clean']) {
      const u = out[v][fcases.length];
      assert(/<a\s[^>]*autolink/.test(u) || /<img[^>]*emoticon/.test(u), `${v}: los filtros no actuaron sobre el control`);
    }
  });
  for (const v of ['noclean', 'clean']) {
    check(`filtros ${v}: ${fcases.length} labels del shell/capítulo/tarjeta — ningún <a>/<img> inyectado y el texto no cambia`, () => {
      const bad = [];
      fcases.forEach((c, i) => {
        const f = out[v][i];
        if (tagCount(f, 'a') !== tagCount(c.html, 'a') || tagCount(f, 'img') !== tagCount(c.html, 'img') || /autolink|emoticon/.test(f)) bad.push(`${c.name}: enlace/imagen inyectado`);
        if (vc.extractText(f) !== vc.extractText(c.html)) bad.push(`${c.name}: texto reescrito`);
        const l = vc.lintCleanSafe(f);
        if (!l.ok) bad.push(`${c.name}: ${JSON.stringify(l.errors.slice(0, 2))}`);
      });
      assert(bad.length === 0, `${bad.length} casos:\n   ${bad.slice(0, 5).join('\n   ')}`);
    });
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) fallaron.`);
  process.exit(1);
}
console.log(`\nPurificador real: ${cases.length} labels verificados contra purify_html() de Moodle.`);
