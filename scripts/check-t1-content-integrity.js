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
  const TE0 = L('modules/theme-engine/index.js').resolveTheme({ themeFamily: 'editorial', mode: 'light' });

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

  // ─── Frases formulaicas ───
  await check('F1 rótulos why/apply: variación determinística (rotan dentro del movimiento, otro punto de partida por capítulo)', () => {
    const lab = (uid) => VC.VC_WHY_LABELS[VC.eduLabelVariant(uid, VC.VC_WHY_LABELS.length)];
    const seq = [0, 1, 2, 3, 4].map((i) => lab(`deepening-ch3-${i}`));
    for (let i = 1; i < seq.length; i++) assert(seq[i] !== seq[i - 1], `dos bloques seguidos con el mismo rótulo: ${seq}`);
    eq(new Set(seq).size, VC.VC_WHY_LABELS.length, 'usa todas las variantes');
    const starts = new Set(Array.from({ length: 15 }, (_, k) => lab(`deepening-ch${k + 1}-0`)));
    assert(starts.size > 1, 'los capítulos no empiezan todos igual');
    eq(lab('deepening-ch3-1'), lab('deepening-ch3-1'), 'determinístico');
    const html = VC.renderComponent({ type: 'checklist', title: 'Lista', items: ['a uno', 'b dos', 'c tres'], why: 'Evita errores.', apply: 'Úsala hoy.' }, TE0, { uid: 'deepening-ch2-1' });
    const t = VC.extractText(html);
    assert(t.includes(`${lab('deepening-ch2-1')}: Evita errores.`) && t.includes(`${VC.VC_APPLY_LABELS[VC.eduLabelVariant('deepening-ch2-1', 3)]}: Úsala hoy.`), t);
  });

  await check('F2 lint de curso: la misma apertura en ≥ 3 capítulos y ≥ 40 % → aviso de calidad (nunca falla); variadas → nada', async () => {
    const exp = (lead, refl, bridge) => ({ movements: { opening: [{ type: 'hero', title: 't', lead }], closing: [{ type: 'reflection', prompt: refl }] }, bridge_to_next: bridge });
    const same = [1, 2, 3, 4, 5].map((n) => exp(`Ya sabes lo del tema ${n}. Ahora viene más.`, `Piensa en tu caso ${n}.`, `Tema ${n} distinto aquí.`));
    eq(VC.formulaicOpeningWarnings(same), ['formulaic_opening:hero_lead:ya_sabes:5/5', 'formulaic_opening:reflection:piensa_en:5/5']);
    const varied = ['Una tarde', 'Cuando llega', 'En la guardia', 'Tres señales', 'Antes de'].map((l, i) => exp(`${l} algo ${i}.`, `${['Recuerda', 'Imagina', 'Revisa', 'Anota', 'Compara'][i]} tu caso.`, `Puente ${i} propio.`));
    eq(VC.formulaicOpeningWarnings(varied), []);
    const r = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true }));
    assert(Array.isArray(r.summary.qualityWarnings), 'summary.qualityWarnings');
    assert(!r.summary.warnings.some((w) => /^formulaic_opening/.test(w)), 'no se mezcla con los avisos operativos');
  });

  // ─── Libro Guía (PDF) ───
  const LB = L('package/v3/libro-v3.js');
  const LL = L('package/v3/libro-logo.js');
  const TE = L('modules/theme-engine/index.js');
  const ROOT = path.resolve(__dirname, '..');
  let pdfjs;
  const pdfPages = async (buf) => {
    pdfjs = pdfjs || (await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs', { paths: [ROOT] })));
    const sf = path.join(path.dirname(require.resolve('pdfjs-dist/package.json', { paths: [ROOT] })), 'standard_fonts') + '/';
    const d = await pdfjs.getDocument({ data: new Uint8Array(buf), standardFontDataUrl: sf, verbosity: 0, isOffscreenCanvasSupported: false, isImageDecoderSupported: false }).promise;
    const out = [];
    for (let p = 1; p <= d.numPages; p++) out.push((await (await d.getPage(p)).getTextContent()).items.map((it) => it.str).filter((x) => x.trim() !== ''));
    return out;
  };
  const pdfItems = async (buf, page) => {
    const d = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0, isOffscreenCanvasSupported: false, isImageDecoderSupported: false }).promise;
    return (await (await d.getPage(page)).getTextContent()).items.filter((it) => it.str.trim() !== '').map((it) => ({ s: it.str, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]) }));
  };
  const MAP_MD = [
    '## Mapa conceptual del capítulo', '',
    '```',
    'Atención a la víctima',
    '├── Valoración inicial ──► Riesgos',
    '│   └── Documentación ▼',
    '└── Activación de la ruta → Notificación ↓',
    '    ◄ Seguimiento ╰─╮ ═══',
    '```', '',
    'Árbol sin cerco:',
    '',
    'Ruta',
    '├─ Salud',
    '└─ Justicia',
    '',
  ].join('\n');
  const ANSWERS_MD = [
    '**Respuesta modelo.**', '',
    '1. Primera respuesta completa.', '', '2. Segunda respuesta completa.', '', '3. Tercera respuesta completa.', '',
    'Otra lista con numeración perezosa:', '',
    '1. Uno', '', '1. Dos', '', '1. Tres', '',
    'Continúa desde el cuatro:', '',
    '4. Cuarta', '5. Quinta', '',
  ].join('\n');
  const NORMS_MD = 'Según la Ley 1257 de 2008 y la Resolución 459 de 2012, el equipo actúa. La Ley 1257 vuelve a citarse. La Sentencia C-355 de 2006 y la norma ISO 9001:2015 también. La Ley 1.098/2006 protege a la infancia.';
  const libroInput = (o = {}) => ({
    courseTitle: 'Curso de prueba de estructura',
    theme: TE.resolveTheme({ themeFamily: 'editorial', mode: 'light' }),
    courseIntro: { schemaVersion: 1, welcome: 'w', competencies: ['c'], methodology_note: 'm', closing: 'c', bibliography: [] },
    modules: [{
      number: 1,
      title: 'Primer módulo',
      intro: { schemaVersion: 1, presentation: 'Presentación del módulo.', outcomes: ['Aplicar la ruta'], journey: [], bibliography: [] },
      chapters: [
        { number: 1, title: 'Primer capítulo', md: `# Capítulo 1\n\nTexto.\n\n${MAP_MD}\n${o.extraMd || ''}` },
        { number: 2, title: 'Segundo capítulo', md: `Texto del segundo.\n\n${NORMS_MD}\n\n${ANSWERS_MD}` },
      ],
    }],
    logo: LL.resolveLibroLogo(null),
    brandName: null,
    ...(o.practice === false ? {} : { practiceChapters: [{ number: 3, title: 'Práctica integradora', moduleNumber: 1 }] }),
    ...(o.refs ? { programReferences: o.refs } : {}),
  });

  await check('L1 mapas conceptuales: conectores de cajas/flechas/triángulos → ASCII de una columna; 0 sin glifo; el mapa conserva su jerarquía', async () => {
    const r = await LB.renderLibroPdfV3(libroInput());
    eq([r.unmappedChars, r.structureUnmappedChars], [0, 0], 'sin caracteres perdidos');
    const pages = await pdfPages(r.pdf);
    const all = pages.flat();
    assert(all.some((x) => /^\+-- Valoración inicial --> Riesgos$/.test(x.trim())), `rama: ${JSON.stringify(all.filter((x) => /Valoración/.test(x)))}`);
    const it1 = await pdfItems(r.pdf, r.chapterPages[1]);
    const rama = it1.find((x) => x.s.startsWith('+-- Valoración'));
    const sub = it1.find((x) => x.s === '+-- Documentación v');
    const bar = sub && it1.find((x) => x.s.trim() === '|' && Math.abs(x.y - sub.y) <= 1);
    assert(rama && sub && bar && sub.x > rama.x && bar.x === rama.x, `sub-rama con «|» y «+--» sangrada: ${JSON.stringify(it1.filter((x) => /Documentaci|Valoraci|^\|/.test(x.s)))}`);
    assert(all.some((x) => /^\+-- Activación de la ruta > Notificación v$/.test(x.trim())), 'flechas → «>» / «v»');
    assert(all.some((x) => x.trim() === '+- Salud') && all.some((x) => x.trim() === '+- Justicia'), 'árbol sin cerco también línea por línea');
    assert(!all.some((x) => /\(abajo\)/.test(x)), 'sin «(abajo)» dentro del mapa');
    eq(LB.structureUnmappedCount('├── ▼ ► → ╰─╮ ═ █'), 0);
    eq(LB.pdfCodeText('│   └── Documentación ▼'), '|   +-- Documentación v');
  });

  await check('L1b glifos: un carácter sin equivalente en un mapa/tabla hace FALLAR el Libro (LIBRO_V3_GLYPHS); un emoji decorativo no', async () => {
    let msg = '';
    try { await LB.renderLibroPdfV3(libroInput({ extraMd: '```\nNodo 漢 central\n```\n' })); } catch (e) { msg = String(e.message || e); }
    assert(/^LIBRO_V3_GLYPHS: 1 caracteres/.test(msg), msg);
    const r = await LB.renderLibroPdfV3(libroInput({ extraMd: '```\n🎯 Nodo central\n```\n' }));
    eq(r.structureUnmappedChars, 0);
  });

  await check('L2 listas numeradas: ítems separados por líneas en blanco siguen 1..n (antes todos «1.»), «1. 1. 1.» → 1,2,3 y «4.» empieza en 4', async () => {
    const r = await LB.renderLibroPdfV3(libroInput());
    const pages = await pdfPages(r.pdf);
    const p = pages[r.chapterPages[2] - 1].concat(pages[r.chapterPages[2]] || []);
    const markers = p.filter((x) => /^\d+\.$/.test(x.trim())).map((x) => Number(x.trim().slice(0, -1)));
    eq(markers, [1, 2, 3, 1, 2, 3, 4, 5], 'marcadores');
    const blocks = LB.parseLibroMarkdown('1. a\n\n2. b\n\n3. c');
    eq(blocks.length, 1, 'una sola lista');
  });

  await check('L3 portada e índice derivados de la estructura: «3 capítulos (2 de contenido y 1 de práctica)», el índice nombra los 3 en orden y sus páginas coinciden', async () => {
    const r = await LB.renderLibroPdfV3(libroInput());
    eq(r.coverLine.startsWith('1 módulo · 3 capítulos (2 de contenido y 1 de práctica)'), true, r.coverLine);
    eq(r.tocChapterNumbers, [1, 2, 3]);
    eq(Object.keys(r.chapterPages).map(Number), [1, 2]);
    const pages = await pdfPages(r.pdf);
    assert(pages[0].join(' ').includes('3 capítulos (2 de contenido y 1 de práctica)'), 'portada');
    const toc = pages[1];
    const items = await pdfItems(r.pdf, 2);
    for (const n of [1, 2]) {
      const line = items.find((x) => x.s.startsWith(`Capítulo ${n}.`));
      const num = items.find((x) => Math.abs(x.y - line.y) <= 3 && /^\d+$/.test(x.s.trim()));
      eq(Number(num && num.s), r.chapterPages[n], `índice → página del capítulo ${n}`);
      assert(pages[r.chapterPages[n] - 1].join(' ').includes(['Primer capítulo', 'Segundo capítulo'][n - 1]), `la página ${r.chapterPages[n]} abre el capítulo ${n}`);
    }
    assert(toc.some((x) => /Capítulo 3\. Práctica integradora · capítulo de práctica/.test(x)), 'práctica en el índice, sin página');
    const r0 = await LB.renderLibroPdfV3(libroInput({ practice: false }));
    eq(r0.coverLine.startsWith('1 módulo · 2 capítulos'), true, 'sin práctica: como antes');
  });

  await check('L4 referencias: normas citadas en el texto (forma más completa, sin inventar) + programa académico → sección «Referencias»; sin fuentes → se omite', async () => {
    eq(LB.citedNormativeReferences([{ number: 2, md: NORMS_MD }]).map((x) => x.label), ['Ley 1257 de 2008', 'Resolución 459 de 2012', 'Sentencia C-355 de 2006', 'ISO 9001:2015', 'Ley 1098 de 2006']);
    eq(LB.citedNormativeReferences([{ number: 1, md: 'La Ley 599 regula.' }, { number: 4, md: 'Ley 599 de 2000.' }]), [{ label: 'Ley 599 de 2000', chapters: [1, 4] }]);
    eq(LB.citedNormativeReferences([{ number: 1, md: 'La Sentencia T-760/08 y la ley del mercado.' }]).map((x) => x.label), ['Sentencia T-760'], 'año abreviado: no se completa');
    const refs = ['Ministerio de Salud (2012). Protocolo de atención. Bogotá.'];
    const r = await LB.renderLibroPdfV3(libroInput({ refs }));
    eq(r.hasReferences, true);
    const pages = await pdfPages(r.pdf);
    const last = pages[pages.length - 1].join(' ');
    assert(/Referencias/.test(last) && /Normas y documentos citados en el texto/.test(last) && /Referencias del programa académico/.test(last) && last.includes('Protocolo de atención'), last.slice(0, 300));
    assert(/Ley 1257 de 2008 — capítulo 2\./.test(last), 'norma con su capítulo');
    assert(pages[1].some((x) => x === 'Referencias'), 'índice con «Referencias»');
    const none = await LB.renderLibroPdfV3({ ...libroInput(), modules: [{ ...libroInput().modules[0], chapters: [{ number: 1, title: 'Uno', md: 'Texto sin normas.' }] }] });
    eq([none.hasReferences, none.citedReferences], [false, []]);
    assert(!(await pdfPages(none.pdf)).flat().some((x) => x === 'Referencias' || x === 'Bibliografía'), 'sin fuentes: sin sección');
  });

  await check('L5 .mbz con capítulos de práctica + referencias del programa: portada/índice/tarjeta del Libro coherentes, «Referencias» en el PDF, validador en verde', async () => {
    const mods = [
      { examEnabled: true, chapters: [{ video: true, activity: true }, { video: false, activity: true }, { practice: true, activity: true }] },
      { examEnabled: false, chapters: [{ video: true, activity: true }, { practice: true, activity: true }] },
    ];
    const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 735, modules: mods });
    const r = await B.buildDynamicMbzV3({ ...input, libroReferences: ['Organización Mundial de la Salud (2003). Guías para la atención. Ginebra.'] });
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 4)));
    const z = await JSZip.loadAsync(r.mbz);
    const files = await z.file('files.xml').async('string');
    const block = (files.match(/<file id="\d+">[\s\S]*?<\/file>/g) || []).find((b) => /<filename>libro_guia_[^<]*\.pdf<\/filename>/.test(b));
    const hash = /<contenthash>([0-9a-f]{40})<\/contenthash>/.exec(block)[1];
    const pdf = await z.file(`files/${hash.slice(0, 2)}/${hash}`).async('nodebuffer');
    const pages = await pdfPages(pdf);
    assert(pages[0].join(' ').includes('5 capítulos (3 de contenido y 2 de práctica)'), `portada: ${pages[0].join(' ')}`);
    const toc = pages[1].join(' ');
    for (const n of [1, 2, 3, 4, 5]) assert(toc.includes(`Capítulo ${n}.`), `índice sin el capítulo ${n}: ${toc}`);
    assert(/Referencias/.test(toc) && pages[pages.length - 1].join(' ').includes('Guías para la atención'), 'referencias del programa');
    const res = Object.keys(z.files).find((f) => /activities\/resource_\d+\/resource\.xml$/.test(f));
    const intro = VC.extractText((await z.file(res).async('string')).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert(/los 3 capítulos de contenido en 2 módulos \(los 2 capítulos de práctica se trabajan en el aula virtual\)/.test(intro), `tarjeta del Libro: ${intro.slice(0, 300)}`);
  });

  await check('L6 referencias del programa: lectura sin contexto → [], falla de lectura → aviso visible (nunca en silencio); clave de reuse solo cambia con referencias', async () => {
    const PK = L('modules/dynamic-packaging/packaging-v3.js');
    eq(await PK.loadLibroReferencesV3({ query: async () => [] }, 1), { references: [], warnings: [] });
    const bad = await PK.loadLibroReferencesV3({ query: async () => { throw new Error('relation "public.course_profiles" does not exist'); } }, 1);
    eq(bad.references, []);
    assert(bad.warnings.length === 1 && /^libro_references_unavailable:/.test(bad.warnings[0]), JSON.stringify(bad.warnings));
    eq(PK.libroReferencesFingerprintV3([]), undefined);
    const k = { builderVersion: 'x', manifestSha256: 'm', sourceArtifactIds: ['a'], themeSha256: 't', assessmentProfileSha256: 'p', h5pProfileVersion: 1, vcRendererVersion: 'v', moodleVersion: '4.5' };
    eq(PK.packageReuseHashV3({ ...k, libroReferencesSha256: undefined }), PK.packageReuseHashV3(k), 'sin referencias: misma clave');
    assert(PK.packageReuseHashV3({ ...k, libroReferencesSha256: PK.libroReferencesFingerprintV3(['R']) }) !== PK.packageReuseHashV3(k), 'con referencias: otra clave');
  });

  console.log(`\n${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
