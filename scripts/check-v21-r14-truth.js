#!/usr/bin/env node
/**
 * R14 (QA factual del showcase) — checks puros sobre dist/:
 *  1. Bibliografía verificada del Libro Guía: solo obras del catálogo, en forma canónica; lo
 *     inventado o mal atribuido se omite (casos REALES del curso #241).
 *  2. Guion del audiolibro: tuteo para Colombia/LatAm (voseo solo en Argentina/Uruguay/Paraguay).
 * Uso: npm run build && node scripts/check-v21-r14-truth.js
 */
const path = require('path');
const assert = require('assert');

const distRoot = path.resolve(process.cwd(), 'dist');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
const VB = loadDist('package/v3/verified-bibliography.js');
const LB = loadDist('package/v3/libro-v3.js');
const TE = loadDist('modules/theme-engine/index.js');
const AS = loadDist('workers/provider-real/audio-scripts.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`❌ ${name}\n   ${err && err.message}`);
  }
}

// Entradas reales generadas por el LLM en el showcase R14 (curso #241).
const REAL = {
  hattie: { author: 'Hattie, John', year: 2009, title: 'Visible Learning: A Synthesis of Over 800 Meta-Analyses Relating to Achievement', publisher: 'Routledge' },
  wigginsGarbled: { author: 'Wiggins, Grant P.', year: 1998, title: 'Educating Authentic Assessment: Designing Assessments for Improving Student Performance', publisher: 'Jossey-Bass' },
  floridiTypo: { author: 'Floridi, Luciano y Cowley, Josh', year: 2019, title: 'A Unified Framework of Five Principles for AI in Society', publisher: 'Harvard Data Science Review' },
  suarezInvented: { author: 'Suárez, Édgar', year: 2022, title: 'Políticas de privacidad y protección de datos en instituciones educativas colombianas: marcos normativos y prácticas', publisher: 'Ministerio de Tecnologías de la Información y las Comunicaciones' },
  selwynMisattributed: { author: 'Selwyn, Neil', year: 2019, title: 'Artificial Intelligence and Education: Critical Perspectives and Challenges', publisher: 'Journal of Education Policy' },
  brookfieldWrongYear: { author: 'Brookfield, Stephen D. y Preskill, Stephen', year: 2005, title: 'The Discussion Book: 50 Great Ways to Get People Talking', publisher: 'Jossey-Bass' },
  selwynReal: { author: 'Selwyn, Neil', year: 2019, title: 'Should Robots Replace Teachers? AI and the Future of Education', publisher: 'Polity Press' },
};

(async () => {
  await check('bibliografía: obras reales se conservan; erratas de autor/título se corrigen a la forma canónica', () => {
    const r = VB.verifyBibliography([REAL.hattie, REAL.wigginsGarbled, REAL.floridiTypo, REAL.selwynReal]);
    assert.strictEqual(r.kept.length, 4);
    assert.strictEqual(r.dropped.length, 0);
    assert.strictEqual(r.kept[1].title, 'Educative Assessment: Designing Assessments to Inform and Improve Student Performance');
    assert.strictEqual(r.kept[2].author, 'Floridi, Luciano y Cowls, Josh');
    assert.strictEqual(r.corrected, 2, 'Wiggins (título) y Floridi (autor); Hattie y Selwyn ya eran canónicas');
  });

  await check('bibliografía: referencias inventadas o mal atribuidas se omiten (nunca se publican)', () => {
    const r = VB.verifyBibliography([REAL.suarezInvented, REAL.selwynMisattributed, REAL.brookfieldWrongYear, REAL.hattie]);
    assert.deepStrictEqual(r.kept.map((b) => b.author), ['Hattie, John']);
    assert.strictEqual(r.dropped.length, 3);
  });

  await check('bibliografía: duplicados (misma obra con erratas distintas) se publican una sola vez', () => {
    const r = VB.verifyBibliography([REAL.hattie, { ...REAL.hattie, title: 'Visible learning: a synthesis of over 800 meta-analyses relating to achievement' }]);
    assert.strictEqual(r.kept.length, 1);
  });

  const theme = TE.resolveTheme({ themeFamily: 'editorial', mode: 'light' });
  const intro = (bib) => ({ schemaVersion: 1, welcome: 'Hola.', competencies: ['a'], methodology_note: 'm', closing: 'c', bibliography: bib });
  const mod = (bib) => ({ number: 1, title: 'Módulo', intro: { schemaVersion: 1, presentation: 'p', outcomes: ['o'], journey: [], bibliography: bib }, chapters: [{ number: 1, title: 'Cap', md: '# Cap\n\nTexto.' }] });

  await check('Libro Guía: la sección de bibliografía muestra solo obras verificadas, en forma canónica', () => {
    const html = LB.compileLibroHtmlV3({ courseTitle: 'Curso', theme, courseIntro: intro([REAL.hattie, REAL.suarezInvented]), modules: [mod([REAL.floridiTypo, REAL.selwynMisattributed])] });
    assert.ok(html.includes('Visible Learning') && html.includes('Cowls, Josh'), 'canónicas presentes');
    assert.ok(!/Suárez|Cowley|Critical Perspectives and Challenges/.test(html), 'inventadas/erratas ausentes');
    assert.ok(html.includes('href="#bibliografia"'), 'índice enlaza la bibliografía');
  });

  await check('Libro Guía: sin ninguna obra verificable → no hay sección ni enlace de bibliografía vacíos', () => {
    const html = LB.compileLibroHtmlV3({ courseTitle: 'Curso', theme, courseIntro: intro([REAL.suarezInvented]), modules: [mod([REAL.selwynMisattributed])] });
    assert.ok(!html.includes('id="bibliografia"') && !html.includes('href="#bibliografia"'), 'sin sección vacía');
    assert.ok(/<\/html>\s*$/.test(html));
  });

  await check('audiolibro: el guion pide tuteo en Colombia (narración y continuación); en Argentina no impone tuteo', () => {
    const co = AS.chapterNarrationPrompt({ courseTitle: 'C', chapterNumber: 1, chapterTitle: 'T', pais: 'Colombia', contentMarkdown: 'x' });
    assert.ok(/tuteo/.test(co.system) && /nunca voseo/.test(co.system), 'narración');
    const cont = AS.chapterContinuationPrompt('texto', 'T', 100, 'Colombia');
    assert.ok(/tuteo/.test(cont.system), 'continuación');
    const ar = AS.chapterNarrationPrompt({ courseTitle: 'C', chapterNumber: 1, chapterTitle: 'T', pais: 'Argentina', contentMarkdown: 'x' });
    assert.ok(!/nunca voseo/.test(ar.system), 'Argentina');
    const none = AS.chapterNarrationPrompt({ courseTitle: 'C', chapterNumber: 1, chapterTitle: 'T', contentMarkdown: 'x' });
    assert.ok(/tuteo/.test(none.system), 'sin país → tuteo latinoamericano');
  });

  console.log(`\n${failed === 0 ? 'Todos los checks de R14 (veracidad) pasaron' : failed + ' check(s) fallaron'} (${passed} ✅, ${failed} ❌).`);
  process.exit(failed === 0 ? 0 : 1);
})();
