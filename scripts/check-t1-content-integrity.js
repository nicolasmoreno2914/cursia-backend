#!/usr/bin/env node
/* eslint-disable no-console */
// T1 (r57) — defectos de contenido repetibles detectados en un curso real (genéricos, sin IA, sin red, sin DB):
//   V1–V4  vocabulario interno del generador («worked_example», «texto fuente», «[S12]»…): reparación determinística
//          con artículo correcto, exención por dominio, el builder lo repara y el validador del .mbz lo rechaza.
//   (más casos se agregan abajo: Libro Guía, frases formulaicas, sesgo de longitud del video).
//
// Usage: node scripts/check-t1-content-integrity.js [path/to/dist]   (npm run build antes)

const path = require('path');
const assert = require('assert');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const L = (rel) => require(path.join(distRoot, rel));

let ok = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    ok++;
    console.log(`✅ ${name}`);
  } catch (err) {
    fail++;
    console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);

(async () => {
  const VC = L('modules/visual-components/index.js');
  const B = L('package/dynamic-mbz-builder-v3.js');
  const V = L('package/v3/mbz-validator-v3.js');
  const PF = require('./lib/v21-packaging-fixtures');
  const JSZip = require('jszip');

  await check('V1 reparación determinística: ids de bloque y «texto fuente» → lenguaje natural con el artículo correcto', () => {
    const cases = [
      ['Piensa en la situación ilustrativa del worked_example.', 'Piensa en la situación ilustrativa del ejemplo resuelto.'],
      ['El texto fuente establece que la tabla 7.1 del texto fuente resume los plazos.', 'El Libro Guía establece que la tabla 7.1 del Libro Guía resume los plazos.'],
      ['Vuelve al case_scenario y revisa las concept_cards.', 'Vuelve al caso y revisa los conceptos clave.'],
      ['Usa la checklist: según la summary_visual y un worked example.', 'Usa la checklist: según la síntesis y un ejemplo resuelto.'],
      ['La dosis correcta [S12] se ajusta al peso [S3, S4].', 'La dosis correcta se ajusta al peso.'],
      ['Worked_example: revisa los datos.', 'Ejemplo resuelto: revisa los datos.'],
      ['Texto sin nada interno.', 'Texto sin nada interno.'],
    ];
    for (const [inp, want] of cases) eq(VC.repairInternalVocabulary(inp).text, want, inp);
    eq(VC.lintInternalVocabulary('Piensa en la situación ilustrativa del worked_example.').map((h) => h.rule), ['worked_example']);
    eq(VC.lintInternalVocabulary('Un caso del tema con una checklist y un hero del cómic.'), [], 'palabras corrientes no son vocabulario interno');
  });

  await check('V2 exención por dominio: si el Libro del curso usa el término (p. ej. traducción: «texto fuente»), no se toca', () => {
    const ex = VC.internalVocabularyExemptions(['# Traducción\nEl texto fuente se compara con el texto meta.']);
    eq(ex, ['texto_fuente']);
    eq(VC.repairInternalVocabulary('Relee el texto fuente.', ex).text, 'Relee el texto fuente.');
    eq(VC.lintInternalVocabulary('Relee el texto fuente.', ex), []);
    eq(VC.repairInternalVocabulary('Relee el worked_example.', ex).text, 'Relee el ejemplo resuelto.', 'las demás reglas siguen');
  });

  await check('V3 reparación profunda: nunca toca ids/tipos (type: worked_example) ni la evidencia; copia sin mutar', () => {
    const doc = { type: 'worked_example', title: 'Caso', situation: 'Según el texto fuente, el worked_example muestra…', evidence: 'cita del texto fuente', refs: ['S12'], items: ['Repasa el case_scenario.'] };
    const r = VC.repairInternalVocabularyDeep(doc);
    eq(r.value, { type: 'worked_example', title: 'Caso', situation: 'Según el Libro Guía, el ejemplo resuelto muestra…', evidence: 'cita del texto fuente', refs: ['S12'], items: ['Repasa el caso.'] });
    eq(doc.situation, 'Según el texto fuente, el worked_example muestra…', 'la entrada no se muta');
    eq(r.fixes.sort(), ['case_scenario', 'texto_fuente', 'worked_example']);
  });

  // Paquete de referencia con una fuga inyectada en el cierre (reflection) y en la intro del curso.
  const leakyInput = () => {
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true });
    const [chId, exp] = Array.from(input.contents.experiences.entries())[1];
    const e = JSON.parse(JSON.stringify(exp));
    const refl = e.movements.closing.find((c) => c.type === 'reflection');
    refl.prompt = 'Piensa en la situación ilustrativa del worked_example y en lo que harías distinto.';
    input.contents.experiences.set(chId, e);
    return { input, chId };
  };

  await check('V4 builder: repara la fuga ANTES de renderizar (aviso internal_vocabulary_repaired) y el validador queda limpio', async () => {
    const { input, chId } = leakyInput();
    const r = await B.buildDynamicMbzV3(input);
    assert(r.summary.warnings.includes('internal_vocabulary_repaired:worked_example:1'), JSON.stringify(r.summary.warnings));
    eq(r.expectations.internalVocabularyExempt, []);
    const z = await JSZip.loadAsync(r.mbz);
    const labels = await Promise.all(Object.keys(z.files).filter((f) => /label\.xml$/.test(f)).map((f) => z.file(f).async('string')));
    assert(!labels.some((x) => /worked_example/.test(x.replace(/cvc-[a-z_-]+/g, ''))), 'ningún label conserva el id');
    assert(labels.some((x) => x.includes('situación ilustrativa del ejemplo resuelto')), 'texto reparado presente');
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 4)));
    void chId;
  });

  await check('V4b validador: un .mbz con vocabulario interno en un label o página FALLA con INTERNAL_VOCABULARY', async () => {
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true });
    const r = await B.buildDynamicMbzV3(input);
    const z = await JSZip.loadAsync(r.mbz);
    // Inyecta la fuga en el texto del primer label de cierre de capítulo.
    let target = null;
    for (const p of Object.keys(z.files).filter((x) => /activities\/label_\d+\/label\.xml$/.test(x))) {
      const x = await z.file(p).async('string');
      if (/cvc-bridge|Para reflexionar/.test(x)) { target = p; break; }
    }
    assert(target, 'label de cierre');
    const x = await z.file(target).async('string');
    const i = x.indexOf('&lt;span class=&quot;nolink&quot;&gt;') + '&lt;span class=&quot;nolink&quot;&gt;'.length;
    z.file(target, x.slice(0, i) + 'Revisa el worked_example y el texto fuente. ' + x.slice(i));
    const bad = await z.generateAsync({ type: 'nodebuffer' });
    const v = await V.validateMbzV3(bad, r.expectations);
    const hits = v.issues.filter((s) => s.code === 'INTERNAL_VOCABULARY');
    assert(hits.length === 1 && /worked_example/.test(hits[0].message) && /texto fuente/.test(hits[0].message), JSON.stringify(v.issues.slice(0, 4)));
    // Expectativas viejas (sin exenciones) no re-juzgan paquetes anteriores.
    const { internalVocabularyExempt, ...old } = r.expectations;
    void internalVocabularyExempt;
    const v2 = await V.validateMbzV3(bad, old);
    assert(!v2.issues.some((s) => s.code === 'INTERNAL_VOCABULARY'), 'expectativas viejas: sin el check');
  });

  console.log(`\n${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
