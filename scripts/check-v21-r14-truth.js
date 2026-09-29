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
const RP = loadDist('workers/provider-real/real-providers.js');
const BL = loadDist('package/h5p/types/blanks.js');

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
  await check('bibliografía: obras reales se conservan; una errata de AUTOR con el título exacto se corrige a la forma canónica; un título deformado se omite (ante la duda, omitir)', () => {
    const r = VB.verifyBibliography([REAL.hattie, REAL.wigginsGarbled, REAL.floridiTypo, REAL.selwynReal, { author: 'John Hattie', year: 2009, title: 'Visible learning: a synthesis of over 800 meta-analyses relating to achievement', publisher: 'Routledge' }]);
    assert.deepStrictEqual(r.kept.map((b) => b.author), ['Hattie, John', 'Floridi, Luciano y Cowls, Josh', 'Selwyn, Neil'], JSON.stringify(r.kept));
    assert.deepStrictEqual(r.dropped.map((b) => b.author), ['Wiggins, Grant P.']);
    assert.strictEqual(r.corrected, 1, 'Floridi (autor)');
  });

  await check('bibliografía (revisión): otra obra real del mismo autor y año, otra ley o un título mínimo NUNCA se publican como la obra del catálogo', () => {
    const cases = [
      { author: 'Black, Paul y Wiliam, Dylan', year: 1998, title: 'Inside the Black Box: Raising Standards Through Classroom Assessment', publisher: 'Phi Delta Kappan' },
      { author: 'Congreso de la República de Colombia', year: 2012, title: 'Ley 1480 de 2012, por la cual se dictan disposiciones generales', publisher: 'Diario Oficial' },
      { author: 'Mayer, Richard E.', year: 2009, title: 'Learning and multimedia instruction', publisher: 'X' },
      { author: 'Hattie, John', year: 2009, title: 'Learning', publisher: 'X' },
      { author: 'Hattie, John', year: 2007, title: 'Feedback power in schools', publisher: 'X' },
    ];
    const r = VB.verifyBibliography(cases);
    assert.deepStrictEqual(r.kept, [], JSON.stringify(r.kept));
  });

  await check('bibliografía (re-revisión): ediciones, citas sin subtítulo y autores institucionales abreviados se reconocen', () => {
    const cases = [
      { author: 'Mayer, Richard E.', year: 2009, title: 'Multimedia learning (2nd ed.)', publisher: 'Cambridge' },
      { author: 'Wiggins, Grant y McTighe, Jay', year: 2005, title: 'Understanding by Design, Expanded 2nd Edition', publisher: 'ASCD' },
      { author: 'Biggs, John y Tang, Catherine', year: 2011, title: 'Teaching for Quality Learning at University (4th ed.)', publisher: 'McGraw-Hill' },
      { author: 'Hattie, John', year: 2009, title: 'Visible Learning', publisher: 'Routledge' },
      { author: 'Wiggins, Grant', year: 1998, title: 'Educative Assessment', publisher: 'Jossey-Bass' },
      { author: 'U.S. Department of Education', year: 2023, title: 'Artificial Intelligence and the Future of Teaching and Learning', publisher: 'U.S. Department of Education' },
      { author: 'Organización de las Naciones Unidas para la Educación, la Ciencia y la Cultura', year: 2023, title: 'Guidance for generative AI in education and research', publisher: 'UNESCO' },
    ];
    const r = VB.verifyBibliography(cases);
    assert.strictEqual(r.kept.length, 7, JSON.stringify(r.dropped));
    // sin subtítulo pero con UNA sola palabra de título principal → no alcanza (sigue omitido)
    assert.strictEqual(VB.verifyBibliography([{ author: 'Hattie, John', year: 2009, title: 'Learning', publisher: 'X' }]).kept.length, 0);
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

  await check('audiolibro (R14-11): narración y continuación prohíben multiplicadores atribuidos a investigación y cifras que no estén en el extracto', () => {
    const co = AS.chapterNarrationPrompt({ courseTitle: 'C', chapterNumber: 1, chapterTitle: 'T', pais: 'Colombia', contentMarkdown: 'x' });
    const cont = AS.chapterContinuationPrompt('texto', 'T', 100, 'Colombia');
    for (const [name, p] of [['narración', co], ['continuación', cont]]) {
      assert.ok(/multiplicadores/.test(p.system) && /triplica/.test(p.system), `${name}: multiplicadores`);
      assert.ok(/No inventes ni exageres/.test(p.system), `${name}: veracidad`);
    }
  });

  await check('Gamma (R14-12): las instrucciones prohíben rotular casos ilustrativos como reales, agregarles resultados y citar a personas', () => {
    const b = RP.gammaGenerationBody({ chapterTitle: 'T', contentMarkdown: 'x', themeId: 't' });
    const ins = String(b.additionalInstructions);
    assert.ok(/caso real/.test(ins) && /ejemplo real/.test(ins), 'rótulos');
    assert.ok(/ilustrativ/.test(ins) && /resultados/.test(ins), 'casos ilustrativos sin resultados agregados');
    assert.ok(/atribu/.test(ins), 'sin frases atribuidas a autores');
  });

  await check('audiolibro (R14-13): narración y continuación prohíben anunciar apartados que no se narran y mencionar "el extracto"', () => {
    const co = AS.chapterNarrationPrompt({ courseTitle: 'C', chapterNumber: 1, chapterTitle: 'T', pais: 'Colombia', contentMarkdown: 'x' });
    const cont = AS.chapterContinuationPrompt('texto', 'T', 100, 'Colombia');
    for (const [n, p] of [['narración', co], ['continuación', cont]]) assert.ok(/siguiente apartado/.test(p.system) && /extracto/.test(p.system) && /idea completa/.test(p.system), n);
  });

  await check('H5P Blanks (R14-13): práctica calificada tolera errores menores de ortografía (el estudiante tipea)', () => {
    const b = BL.buildBlanks({ itemKey: 'activity:c1', title: 'T', text: 'Completa.', questions: ['La *brújula* orienta.', 'El *prompt* instruye.', 'La *rúbrica* guía.', 'El *sesgo* distorsiona.'] });
    assert.strictEqual(b.content.behaviour.acceptSpellingErrors, true);
    assert.strictEqual(b.content.behaviour.caseSensitive, false);
  });

  await check('Gamma (R14-13): no afirmar capacidades permanentes de la IA ni siglas de leyes de otro país', () => {
    const ins = String(RP.gammaGenerationBody({ chapterTitle: 'T', contentMarkdown: 'x', themeId: 't' }).additionalInstructions);
    assert.ok(/depende de la herramienta/.test(ins) && /LOPD/.test(ins), ins);
  });

  console.log(`\n${failed === 0 ? 'Todos los checks de R14 (veracidad) pasaron' : failed + ' check(s) fallaron'} (${passed} ✅, ${failed} ❌).`);
  process.exit(failed === 0 ? 0 : 1);
})();
