#!/usr/bin/env node
/* eslint-disable */
// R2 (Cursia V2.1) — fix round 1 / I6: Visual Components frente a los FILTROS de Moodle.
//
// Ejecuta los labels renderizados por format_text() real del Moodle local (filtros activos
// del sitio: activitynames, emoticon, urltolink, mediaplugin, displayh5p, mathjaxloader) en
// las dos variantes con que Moodle muestra un label: `noclean` (default de mod_label) y
// limpia (≡ forceclean=1). Cada campo de texto de cada fixture lleva "disparadores": nombres
// reales de actividades del curso de contexto, emoticones y URLs. Exige:
//   - control: el mismo disparador SIN nuestro markup sí es filtrado (prueba que los filtros
//     están activos; si no, el check no demuestra nada y falla);
//   - ningún <a> ni <img> inyectado en nuestros labels;
//   - extractText(filtrado) === extractText(original) (el texto no se reescribe);
//   - lintCleanSafe(filtrado) pasa (incluye LINK_WITHOUT_COLOR).
//
// Solo lectura (scripts/lib/moodle-format.php). Requiere dist/ y el Moodle local.
// Uso: node scripts/check-v21-vc-moodle-filters.js

const path = require('path');
const F = require('./lib/v21-vc-fixtures');
const { moodleFormat, MOODLE_CONFIG } = require('./lib/v21-moodle-purify');

let vc, te;
try {
  vc = require(path.resolve(process.cwd(), 'dist/modules/visual-components/index.js'));
  te = require(path.resolve(process.cwd(), 'dist/modules/theme-engine/index.js'));
} catch (err) {
  console.error('❌ No se pudo cargar dist/ (¿corriste "npm run build"?)');
  console.error(`   ${err.message}`);
  process.exit(1);
}

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

let probe;
try {
  probe = moodleFormat({ mode: 'probe' });
} catch (err) {
  console.error(`❌ format_text() del Moodle local no disponible (${MOODLE_CONFIG})`);
  console.error(`   ${err.message}`);
  process.exit(1);
}
const names = probe.names.slice(0, 2);
const TRIGGER = `${names.join(' y ')} (y) (i) :-) 8-) https://example.com/recurso www.example.org/guia`;

function withTriggers(c) {
  const walk = (v, key) => {
    if (key === 'type' || key === 'variant') return v;
    if (typeof v === 'string') return `${v} ${TRIGGER}`;
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], k);
      return o;
    }
    return v;
  };
  return walk(F.clone(c), null);
}

const combos = [F.THEME_COMBOS[0], F.THEME_COMBOS.find((c) => c.themeFamily === 'oscuro-premium')];
const cases = [];
for (const combo of combos) {
  const theme = te.resolveTheme(combo);
  for (const [i, c] of F.loadComponents().entries()) {
    for (const level of [undefined, 'enhanced']) {
      cases.push({ name: `${F.themeLabel(combo)}/${F.fixtureName(c)}/${level || 'clean'}`, html: vc.renderMovement([withTriggers(c)], theme, { uid: `f${i}`, level }) });
    }
  }
}
const control = `<div style="background-color:#FAFAFA;color:#111111"><p>${TRIGGER.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p></div>`;

// control 2: uno de NUESTROS labels sin la clase nolink sí es filtrado (la protección es la clase).
const unprotected = cases[0].html.split('<span class="nolink">').join('<span>');
const out = moodleFormat({ mode: 'format', cmid: probe.cmid, items: [control, ...cases.map((c) => c.html), unprotected] });

check(`control: los filtros del sitio están activos (curso ${probe.courseid}, cm ${probe.cmid})`, () => {
  for (const v of ['noclean', 'clean']) {
    const f = out[v][0];
    assert(/<a\s[^>]*autolink/.test(f), `${v}: activitynames no enlazó "${names[0]}" en el control`);
    assert(/<img[^>]*emoticon/.test(f), `${v}: emoticon no actuó en el control`);
    assert(/<a\s[^>]*href="https:\/\/example\.com\/recurso"/.test(f), `${v}: urltolink no actuó en el control`);
    const u = out[v][cases.length + 1];
    assert(/<a\s[^>]*autolink/.test(u) && /<img[^>]*emoticon/.test(u), `${v}: sin nolink nuestro label SÍ debería filtrarse`);
  }
});

for (const v of ['noclean', 'clean']) {
  check(`${v}: ningún enlace/imagen inyectado en ${cases.length} labels`, () => {
    const bad = [];
    cases.forEach((c, i) => {
      const f = out[v][i + 1];
      if (/<a[\s>]/i.test(f) || /<img[\s>]/i.test(f)) bad.push(`${c.name}: ${(f.match(/<(a|img)\s[^>]{0,80}/i) || [''])[0]}`);
    });
    assert(bad.length === 0, `${bad.length} casos:\n   ${bad.slice(0, 5).join('\n   ')}`);
  });
  check(`${v}: el texto sale idéntico (extractText) y lintCleanSafe pasa`, () => {
    const bad = [];
    cases.forEach((c, i) => {
      const f = out[v][i + 1];
      if (vc.extractText(f) !== vc.extractText(c.html)) bad.push(`${c.name}: texto reescrito`);
      const l = vc.lintCleanSafe(f);
      if (!l.ok) bad.push(`${c.name}: ${JSON.stringify(l.errors.slice(0, 2))}`);
    });
    assert(bad.length === 0, `${bad.length} casos:\n   ${bad.slice(0, 5).join('\n   ')}`);
  });
}

check('lintCleanSafe detecta un enlace inyectado por filtros en un markup sin protección', () => {
  const r = vc.lintCleanSafe(out.noclean[0]);
  assert(!r.ok && r.errors.some((e) => e.code === 'LINK_WITHOUT_COLOR'), JSON.stringify(r.errors));
});

if (failures > 0) {
  console.error(`\n${failures} check(s) fallaron.`);
  process.exit(1);
}
console.log(`\nFiltros de Moodle: ${cases.length} labels × {noclean, clean} verificados con format_text().`);
