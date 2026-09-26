#!/usr/bin/env node
/* eslint-disable */
// R2 (Cursia V2.1) — Visual Components contra el purificador REAL de Moodle (forceclean=1).
//
// Llama a purify_html() de un Moodle local vía PHP CLI (scripts/lib/moodle-purify.php; solo
// lectura, sin tocar la configuración del sitio). Para cada fixture (16 tipos + variantes de
// callout, normal y con textos de 400 caracteres) × familias × modos × {CLEAN_SAFE, ENHANCED},
// y para cada movimiento del capítulo completo, exige:
//   - extractText(purificado) === extractText(original)   → 100 % del texto pedagógico sobrevive;
//   - lintCleanSafe(purificado) pasa;
//   - el purificado no conserva <style>/<script>/<details>/aria (confirma el modelo §X.1);
//   - para CLEAN_SAFE, el purificador no descarta NINGUNA declaración inline (todas eran seguras).
//
// Requiere dist/ (npm run build) y el Moodle local (Postgres en marcha). Falla fuerte si no.
// Uso: node scripts/check-v21-vc-purifier.js

const path = require('path');
const F = require('./lib/v21-vc-fixtures');
const { purifyMany, MOODLE_CONFIG } = require('./lib/v21-moodle-purify');

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

// ─── Casos ──────────────────────────────────────────────────────────────────
const cases = [];
const components = F.loadComponents();
const doc = F.buildExperience();
for (const combo of F.THEME_COMBOS) {
  const theme = te.resolveTheme(combo);
  const tl = F.themeLabel(combo);
  for (const [i, c] of components.entries()) {
    for (const [vname, variant] of [['normal', c], ['largo', F.longVariant(c)]]) {
      for (const level of [undefined, 'enhanced']) {
        cases.push({
          name: `${tl}/${c.type}${c.type === 'callout' ? ':' + c.variant : ''}/${vname}/${level || 'clean'}`,
          level,
          html: vc.renderMovement([variant], theme, { uid: `p${i}`, level }),
        });
      }
    }
  }
  for (const [mv, list] of Object.entries(doc.movements)) {
    for (const level of [undefined, 'enhanced']) {
      cases.push({ name: `${tl}/movimiento:${mv}/${level || 'clean'}`, level, html: vc.renderMovement(list, theme, { uid: `mv-${mv.replace('_', '-')}`, level }) });
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
    for (const d of vc.parseStyle(el.attrs.style)) counts[d.prop] = (counts[d.prop] || 0) + 1;
    el.children.forEach(walk);
  };
  walk(vc.parseHtml(html));
  return counts;
}

check(`purify_html real disponible y devuelve ${cases.length} resultados`, () => {
  assert(purified.length === cases.length, 'cantidad');
  assert(purified.every((p) => typeof p === 'string' && p.length > 0), 'resultado vacío');
});

check('100 % del texto pedagógico sobrevive forceclean (extractText idéntico) en todos los casos', () => {
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

check('lintCleanSafe pasa sobre el HTML purificado en todos los casos', () => {
  const bad = [];
  cases.forEach((c, i) => {
    const r = vc.lintCleanSafe(purified[i]);
    if (!r.ok) bad.push(`${c.name}: ${JSON.stringify(r.errors.slice(0, 2))}`);
  });
  assert(bad.length === 0, `${bad.length} casos:\n   ${bad.slice(0, 5).join('\n   ')}`);
});

check('el purificado no conserva la capa ENHANCED (<style>, <script>, <details>, aria, data-, display)', () => {
  cases.forEach((c, i) => {
    const p = purified[i];
    for (const bad of ['<style', '<script', '<details', '<summary', 'aria-', 'data-cvc', 'display:', 'border-radius', 'box-shadow', 'clamp(']) {
      assert(!p.includes(bad), `${c.name}: "${bad}" sobrevivió a forceclean (el modelo §X.1 no se cumple)`);
    }
  });
});

check('CLEAN_SAFE: el purificador no descarta ninguna declaración inline (todas son seguras)', () => {
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

check('ENHANCED purificado ≡ CLEAN_SAFE purificado en texto (misma información en ambos niveles)', () => {
  const byName = new Map(cases.map((c, i) => [c.name, i]));
  for (const c of cases.filter((x) => x.level === 'enhanced')) {
    const j = byName.get(c.name.replace(/\/enhanced$/, '/clean'));
    assert(j !== undefined, `par CLEAN_SAFE de ${c.name}`);
    assert(vc.extractText(purified[byName.get(c.name)]) === vc.extractText(purified[j]), `${c.name}: texto distinto al CLEAN_SAFE`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} check(s) fallaron.`);
  process.exit(1);
}
console.log(`\nPurificador real: ${cases.length} renders verificados contra purify_html() de Moodle.`);
