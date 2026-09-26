#!/usr/bin/env node
/* eslint-disable */
// R9 — Gamma V2 presentation acceptance check (v2.1). No-DB, no-network, no
// Gamma calls — pure function checks against the COMPILED modules, same
// pattern as check-generation-manifest-determinism.js / check-v21-theme-engine.js.
//
// Usage:
//   node scripts/check-v21-presentation.js
//   V21_AUDIT_MBZ_DIR=/path/to/scratch/v21audit/mbz node scripts/check-v21-presentation.js

const path = require('path');

function loadDist(rel) {
  const modulePath = path.resolve(process.cwd(), rel);
  try {
    return require(modulePath);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${modulePath}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

const presentation = loadDist('dist/package/presentation/index.js');
const themeEngine = loadDist('dist/modules/theme-engine/index.js');

const {
  PRESENTATION_ARTIFACT_SCHEMA_VERSION,
  validatePresentationArtifact,
  pdfPageCount,
  PdfPageCountUnknownError,
  pngDimensions,
  presentationCardHtml,
  lintCleanSafeMinimal,
  gammaThemeFor,
  themeMismatch,
  mockPresentationArtifactFromFixture,
  loadV1ChapterBytes,
  locateAuditMbzDir,
  v1FixtureChapterNumbers,
  syntheticOnePagePdf,
  syntheticOnePxPng,
} = presentation;

const { resolveTheme, moduleColor, THEME_FAMILIES } = themeEngine;

for (const [name, val] of Object.entries({
  PRESENTATION_ARTIFACT_SCHEMA_VERSION,
  validatePresentationArtifact,
  pdfPageCount,
  PdfPageCountUnknownError,
  pngDimensions,
  presentationCardHtml,
  lintCleanSafeMinimal,
  gammaThemeFor,
  themeMismatch,
  mockPresentationArtifactFromFixture,
  loadV1ChapterBytes,
  locateAuditMbzDir,
  v1FixtureChapterNumbers,
  syntheticOnePagePdf,
  syntheticOnePxPng,
})) {
  if (val === undefined) {
    console.error(`❌ dist/package/presentation/index.js no exporta "${name}".`);
    process.exit(1);
  }
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: esperado ${JSON.stringify(expected)}, encontrado ${JSON.stringify(actual)}`);
  }
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertThrows(fn, msg) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error(`se esperaba que lanzara: ${msg}`);
}

// ── 1: page count del PDF sintético (1 página, sin comprimir) ──────────────
check('1: pdfPageCount — PDF sintético de 1 página', () => {
  const n = pdfPageCount(syntheticOnePagePdf());
  assertEqual(n, 1, 'PDF sintético debe tener 1 página');
});

// ── 1b: page count de los 9 PDFs reales de V1 cuando el scratch está presente ──
const mbzDir = locateAuditMbzDir();
if (mbzDir) {
  console.log(`   (scratch de auditoría encontrado en ${mbzDir} — usando blobs reales de V1)`);
} else {
  console.log('   (scratch de auditoría no encontrado — se usan fixtures sintéticas para los 9 capítulos)');
}
check('1b: pdfPageCount — los 9 PDFs de V1 (reales si hay scratch, sintéticos si no)', () => {
  const numbers = v1FixtureChapterNumbers();
  assertEqual(numbers.length, 9, 'debe haber metadata de 9 capítulos en el fixture');
  for (const n of numbers) {
    const { pdfBytes, real } = loadV1ChapterBytes(n);
    const count = pdfPageCount(pdfBytes);
    assertTrue(Number.isInteger(count) && count >= 1, `cap${n}: page count inválido (${count})`);
    // M8: los PDFs reales de V1 tienen exactamente 10 páginas (medido); fijado para detectar regresiones.
    if (real) assertEqual(count, 10, `cap${n}: el PDF real de V1 tiene 10 páginas`);
    console.log(`      cap${n}_presentacion.pdf (${real ? 'real V1' : 'sintético'}): ${count} páginas`);
  }
});

check('1c: pdfPageCount — buffer sin cabecera %PDF- lanza PDF_PAGECOUNT_UNKNOWN', () => {
  const e = assertThrows(() => pdfPageCount(Buffer.from('no soy un pdf')), 'buffer inválido');
  assertTrue(e.message.startsWith('PDF_PAGECOUNT_UNKNOWN'), `mensaje inesperado: ${e.message}`);
});

check('1d: pdfPageCount — PDF sin /Pages ni /Page en absoluto lanza PDF_PAGECOUNT_UNKNOWN', () => {
  const bogus = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'latin1');
  const e = assertThrows(() => pdfPageCount(bogus), 'PDF sin árbol de páginas');
  assertTrue(e.message.startsWith('PDF_PAGECOUNT_UNKNOWN'), `mensaje inesperado: ${e.message}`);
});

// ── 1e–1j: fix round 1 (review G5 I2/M1, sondas p1) — nunca un número dudoso ──
const zlib = require('zlib');
const pdfOf = (s) => Buffer.from(s, 'latin1');
function unknown(buf, what) {
  const e = assertThrows(() => pdfPageCount(buf), what);
  assertTrue(e.code === 'PDF_PAGECOUNT_UNKNOWN', `${what}: código ${e.code} (${e.message})`);
}
check('1e: pdfPageCount — un /Outlines /Count cercano NO contamina: se resuelve /Root → /Pages', () => {
  const near = pdfOf('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [4 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Outlines /First 5 0 R /Count 25 >> endobj\n4 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF');
  assertEqual(pdfPageCount(near), 1, 'outlines cerca');
  const before = pdfOf('%PDF-1.4\n3 0 obj << /Type /Outlines /Count 17 >> endobj\n2 0 obj << /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >> endobj\n4 0 obj << /Type /Page /Parent 2 0 R >> endobj 5 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF');
  assertEqual(pdfPageCount(before), 2, 'outlines antes del /Pages (sin trailer: única raíz /Pages)');
});
check('1f: pdfPageCount — actualización incremental: gana la versión vigente del nodo /Pages', () => {
  const inc = pdfOf('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >> endobj\n4 0 obj << /Type /Page >> endobj 5 0 obj << /Type /Page >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n2 0 obj << /Type /Pages /Kids [4 0 R] /Count 1 >> endobj\ntrailer << /Root 1 0 R /Prev 9 >>\n%%EOF');
  assertEqual(pdfPageCount(inc), 1, 'incremental');
  const incNoTrailer = pdfOf('%PDF-1.4\n2 0 obj << /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >> endobj\n%%EOF\n2 0 obj << /Type /Pages /Kids [4 0 R] /Count 1 >> endobj\n%%EOF');
  assertEqual(pdfPageCount(incNoTrailer), 1, 'incremental sin trailer');
});
check('1g: pdfPageCount — /Count 0, /Count indirecto y raíces /Pages ambiguas → PDF_PAGECOUNT_UNKNOWN', () => {
  unknown(pdfOf('%PDF-1.4\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n%%EOF'), '/Count 0');
  unknown(pdfOf('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 7 0 R >> endobj\ntrailer << /Root 1 0 R >>'), '/Count indirecto');
  unknown(pdfOf('%PDF-1.4\n2 0 obj << /Type /Pages /Count 3 >> endobj\n6 0 obj << /Type /Pages /Count 5 >> endobj\n%%EOF'), 'dos raíces sin /Root');
  unknown(pdfOf('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\ntrailer << /Root 1 0 R >>'), '/Pages inexistente');
});
check('1h: pdfPageCount — ObjStm comprimido con catálogo + xref stream (forma de Gamma)', () => {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Outlines /Count 40 >>', '<< /Type /Pages /Kids [4 0 R] /Count 10 >>'];
  const nums = [1, 3, 2];
  let off = 0; const hdr = []; let body = '';
  objs.forEach((o, i) => { hdr.push(`${nums[i]} ${off}`); body += o + ' '; off += o.length + 1; });
  const head = hdr.join(' ') + ' ';
  const data = zlib.deflateSync(Buffer.from(head + body, 'latin1'));
  const pdf = Buffer.concat([
    pdfOf(`%PDF-1.7\n5 0 obj << /Type /ObjStm /N 3 /First ${head.length} /Filter /FlateDecode /Length ${data.length} >> stream\n`), data,
    pdfOf('\nendstream endobj\n6 0 obj << /Type /XRef /Root 1 0 R /Size 7 >> stream\nxx\nendstream endobj\n%%EOF'),
  ]);
  assertEqual(pdfPageCount(pdf), 10, 'ObjStm + xref stream');
});
check('1i: pdfPageCount — ObjStm que infla > 32 MiB → PDF_PAGECOUNT_UNKNOWN sin agotar memoria', () => {
  const big = zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024));
  const pdf = Buffer.concat([pdfOf('%PDF-1.5\n1 0 obj << /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >> stream\n'), big, pdfOf('\nendstream endobj\n%%EOF')]);
  const rss0 = process.memoryUsage().rss;
  unknown(pdf, 'bomba');
  assertTrue(process.memoryUsage().rss - rss0 < 80e6, 'la bomba consumió demasiada memoria');
});

// ── 2: PNG dimensions ───────────────────────────────────────────────────────
check('2: pngDimensions — PNG sintético de 1x1', () => {
  const { width, height } = pngDimensions(syntheticOnePxPng());
  assertEqual(width, 1, 'width');
  assertEqual(height, 1, 'height');
});
check('2b: pngDimensions — de los 9 covers de V1 (reales si hay scratch)', () => {
  for (const n of v1FixtureChapterNumbers()) {
    const { coverBytes } = loadV1ChapterBytes(n);
    const { width, height } = pngDimensions(coverBytes);
    assertTrue(width > 0 && height > 0, `cap${n}_portada.png: dimensiones inválidas`);
  }
});
check('2c: pngDimensions — firma inválida lanza PNG_DIMENSIONS_UNKNOWN', () => {
  const e = assertThrows(() => pngDimensions(Buffer.from('no soy un png')), 'firma inválida');
  assertTrue(e.message.startsWith('PNG_DIMENSIONS_UNKNOWN'), `mensaje inesperado: ${e.message}`);
});

// ── 3: presentationCardHtml — CLEAN_SAFE lint + N medido + link de respaldo ─
const lightTheme = resolveTheme({ themeFamily: 'aula-clara', mode: 'light' });
const darkTheme = resolveTheme({ themeFamily: 'oscuro-premium', mode: 'dark' });

function buildCard(theme, slideCount) {
  return presentationCardHtml({
    chapterNumber: 3,
    chapterTitle: 'Capítulo con & símbolos <raros> y "comillas"',
    coverUrl: '@@PLUGINFILE@@/cap3_portada.png',
    pdfUrl: '@@PLUGINFILE@@/cap3_presentacion.pdf',
    slideCount,
    theme,
    moduleColor: moduleColor(theme, 0),
  });
}

const vc = require(path.resolve(process.cwd(), 'dist/modules/visual-components/index.js'));
const COMBOS = [
  ['aula-clara', 'light'], ['institucional', 'light'], ['editorial', 'light'], ['vibrante', 'light'],
  ['tecnico', 'light'], ['tecnico', 'dark'], ['oscuro-premium', 'dark'],
];
check('3: presentationCardHtml — pasa lintCleanSafe REAL de R2 en los 7 temas × {CLEAN_SAFE, ENHANCED}; CLEAN_SAFE sin capa ENHANCED; todo texto en nolink', () => {
  for (const [f, m] of COMBOS) {
    const theme = resolveTheme({ themeFamily: f, mode: m });
    for (const level of [undefined, 'enhanced']) {
      for (let mi = 0; mi < 4; mi++) {
        const html = presentationCardHtml({ chapterNumber: 3, chapterTitle: 'Título', coverUrl: 'c.png', pdfUrl: 'p.pdf', slideCount: 10, theme, moduleColor: moduleColor(theme, mi), level });
        const r = vc.lintCleanSafe(html);
        assertTrue(r.ok, `${f}-${m}/${level || 'clean'}/módulo ${mi}: ${JSON.stringify(r.errors.slice(0, 3))}`);
        if (!level) assertTrue(!/border-radius|box-shadow|height:auto|display:|rgba\(/.test(html), `${f}-${m}: capa ENHANCED en CLEAN_SAFE`);
        else assertTrue(/border-radius/.test(html), 'ENHANCED sin radius');
        assertTrue(html.includes('<span class="nolink">Ver presentación completa (PDF, 10 diapositivas)</span>'), 'enlace sin nolink');
      }
    }
  }
});

check('4: presentationCardHtml — contiene el N medido y el link de respaldo, nunca un badge inventado', () => {
  const html = buildCard(lightTheme, 7);
  assertTrue(html.includes('PDF, 7 diapositivas'), 'debe mostrar el conteo real de diapositivas');
  assertTrue(html.includes('@@PLUGINFILE@@/cap3_presentacion.pdf'), 'debe linkear al PDF completo');
  assertTrue(!/Diapositiva 1 de 10/.test(html), 'no debe haber un badge hardcodeado tipo V1');
  // singular correcto
  const singular = buildCard(lightTheme, 1);
  assertTrue(singular.includes('PDF, 1 diapositiva)'), 'singular de "diapositiva" cuando N=1');
});

check('4b: presentationCardHtml — el título (texto libre) no va en atributos: alt fijo, sin HTML crudo', () => {
  const html = buildCard(lightTheme, 5);
  assertTrue(!html.includes('<raros>') && !html.includes('&lt;raros&gt;'), 'el título no debe aparecer en la tarjeta');
  assertTrue(html.includes('alt="Portada de la presentación del capítulo 3"'), 'alt fijo');
});

check('4c: presentationCardHtml — tamaño responsivo del <img> solo en ENHANCED (el purificador lo descarta en <img>)', () => {
  const clean = buildCard(lightTheme, 5).match(/<img[^>]*style="([^"]*)"/)[1];
  assertTrue(!/width/.test(clean), `CLEAN_SAFE no declara width en <img>: ${clean}`);
  const enh = presentationCardHtml({ chapterNumber: 3, chapterTitle: 't', coverUrl: 'c', pdfUrl: 'p', slideCount: 5, theme: lightTheme, moduleColor: moduleColor(lightTheme, 0), level: 'enhanced' }).match(/<img[^>]*style="([^"]*)"/)[1];
  assertTrue(/max-width:100%/.test(enh) && /width:100%/.test(enh) && /height:auto/.test(enh), `ENHANCED responsivo: ${enh}`);
});

check('4d: presentationCardHtml — slideCount inválido (<1 o no entero) falla fuerte', () => {
  assertThrows(() => buildCard(lightTheme, 0), 'slideCount 0');
  assertThrows(() => buildCard(lightTheme, -3), 'slideCount negativo');
  assertThrows(() => buildCard(lightTheme, 2.5), 'slideCount no entero');
});

// ── 5: determinismo ─────────────────────────────────────────────────────────
check('5: determinismo — mismo input produce el mismo HTML byte a byte', () => {
  const a = buildCard(lightTheme, 9);
  const b = buildCard(lightTheme, 9);
  assertEqual(a, b, 'presentationCardHtml debe ser determinístico');
});

// ── 6: mapeo de tema y mismatch ──────────────────────────────────────────────
check('6: gammaThemeFor — falla fuerte sin env configurada', () => {
  delete process.env.GAMMA_THEME_V21_AULA_CLARA_LIGHT;
  delete process.env.GAMMA_THEME_V21_LIGHT_DEFAULT;
  const e = assertThrows(() => gammaThemeFor('aula-clara', 'light'), 'sin config');
  assertTrue(e.message.startsWith('GAMMA_THEME_CONFIG'), `mensaje inesperado: ${e.message}`);
});
check('6b: gammaThemeFor — usa el fallback por modo (light/dark) si no hay override específico', () => {
  process.env.GAMMA_THEME_V21_LIGHT_DEFAULT = 'gamma-light-default-id';
  process.env.GAMMA_THEME_V21_DARK_DEFAULT = 'gamma-dark-default-id';
  assertEqual(gammaThemeFor('editorial', 'light'), 'gamma-light-default-id', 'fallback claro');
  assertEqual(gammaThemeFor('oscuro-premium', 'dark'), 'gamma-dark-default-id', 'fallback oscuro');
});
check('6c: gammaThemeFor — un override específico de familia+modo gana sobre el fallback', () => {
  process.env.GAMMA_THEME_V21_TECNICO_DARK = 'gamma-tecnico-dark-id';
  assertEqual(gammaThemeFor('tecnico', 'dark'), 'gamma-tecnico-dark-id', 'override específico');
  delete process.env.GAMMA_THEME_V21_TECNICO_DARK;
});
check('6d: gammaThemeFor — todas las 6 familias × sus modos soportados resuelven con los defaults puestos', () => {
  for (const family of Object.values(THEME_FAMILIES)) {
    for (const mode of family.supportedModes) {
      const id = gammaThemeFor(family.id, mode);
      assertTrue(typeof id === 'string' && id.length > 0, `${family.id}:${mode} sin id`);
    }
  }
});

check('7: themeMismatch — por tema de Gamma efectivo: cambio de familia y cambio de MODO avisan; nunca regenera', () => {
  process.env.GAMMA_THEME_V21_LIGHT_DEFAULT = 'gamma-light-default-id';
  process.env.GAMMA_THEME_V21_DARK_DEFAULT = 'gamma-dark-default-id';
  process.env.GAMMA_THEME_V21_OSCURO_PREMIUM_DARK = 'gamma-oscuro-id';
  const art = { gammaThemeId: 'gamma-light-default-id', themeFamilyAtGeneration: 'tecnico', themeModeAtGeneration: 'light' };
  const same = themeMismatch(art, { familyId: 'tecnico', mode: 'light' });
  assertEqual(same.mismatch, false, 'mismo tema => sin mismatch');
  assertTrue(same.warning === undefined, 'sin warning cuando no hay mismatch');
  const mode = themeMismatch(art, { familyId: 'tecnico', mode: 'dark' });
  assertEqual(JSON.stringify([mode.mismatch, mode.warning, mode.changed]), JSON.stringify([true, 'theme_mismatch', ['mode', 'gammaTheme']]), 'cambio de modo');
  const fam = themeMismatch(art, { familyId: 'oscuro-premium', mode: 'dark' });
  assertEqual(JSON.stringify([fam.mismatch, fam.changed]), JSON.stringify([true, ['family', 'mode', 'gammaTheme']]), 'cambio de familia');
  // familia distinta que mapea al MISMO tema de Gamma: sin aviso (la presentación ya es la correcta).
  const sameGamma = themeMismatch(art, { familyId: 'editorial', mode: 'light' });
  assertEqual(JSON.stringify([sameGamma.mismatch, sameGamma.changed]), JSON.stringify([false, ['family']]), 'mismo tema Gamma');
  // artifact previo sin modo registrado: la comparación por gammaThemeId sigue funcionando.
  assertEqual(themeMismatch({ gammaThemeId: 'gamma-light-default-id', themeFamilyAtGeneration: 'tecnico' }, { familyId: 'tecnico', mode: 'dark' }).mismatch, true, 'sin modo registrado');
  const r = themeMismatch(art, { familyId: 'tecnico', mode: 'dark' });
  assertTrue(!('regenerate' in r), 'themeMismatch nunca ordena regenerar');
  delete process.env.GAMMA_THEME_V21_OSCURO_PREMIUM_DARK;
});

// ── 8: validatePresentationArtifact ─────────────────────────────────────────
function validArtifact() {
  return {
    schemaVersion: 1,
    chapterId: 'chapter-uuid-1',
    gammaGenerationId: 'gamma-gen-1',
    pdf: { storagePath: 's3://x/cap1.pdf', sha256: 'a'.repeat(64), bytes: 1000 },
    cover: { storagePath: 's3://x/cap1.png', sha256: 'b'.repeat(64), bytes: 500, width: 1280, height: 720 },
    slideCount: 12,
    themeFamilyAtGeneration: 'aula-clara',
    gammaThemeId: 'gamma-theme-x',
    generatedAt: new Date().toISOString(),
  };
}

check('8: validatePresentationArtifact — artifact válido no produce errores', () => {
  const errors = validatePresentationArtifact(validArtifact());
  assertEqual(errors.length, 0, `no debería haber errores: ${JSON.stringify(errors)}`);
});

check('8b: validatePresentationArtifact — rechaza PDF faltante', () => {
  const a = validArtifact();
  delete a.pdf;
  const errors = validatePresentationArtifact(a);
  assertTrue(
    errors.some((e) => e.code === 'PDF_MISSING'),
    `debía reportar PDF_MISSING: ${JSON.stringify(errors)}`,
  );
});

check('8c: validatePresentationArtifact — rechaza cover faltante', () => {
  const a = validArtifact();
  delete a.cover;
  const errors = validatePresentationArtifact(a);
  assertTrue(
    errors.some((e) => e.code === 'COVER_MISSING'),
    `debía reportar COVER_MISSING: ${JSON.stringify(errors)}`,
  );
});

check('8d: validatePresentationArtifact — rechaza slideCount < 1', () => {
  for (const bad of [0, -1, 0.5, undefined, null]) {
    const a = validArtifact();
    a.slideCount = bad;
    const errors = validatePresentationArtifact(a);
    assertTrue(
      errors.some((e) => e.code === 'SLIDE_COUNT'),
      `slideCount=${bad} debía reportar SLIDE_COUNT: ${JSON.stringify(errors)}`,
    );
  }
});

check('8e: validatePresentationArtifact — rechaza schemaVersion incorrecta y objetos no-objeto', () => {
  const a = validArtifact();
  a.schemaVersion = 2;
  assertTrue(validatePresentationArtifact(a).some((e) => e.code === 'SCHEMA_VERSION'));
  assertTrue(validatePresentationArtifact(null).some((e) => e.code === 'NOT_AN_OBJECT'));
  assertTrue(validatePresentationArtifact('nope').some((e) => e.code === 'NOT_AN_OBJECT'));
});

check('8f: validatePresentationArtifact — mock ⇔ gammaGenerationId null (M13) y themeModeAtGeneration válido', () => {
  const a = validArtifact(); a.gammaGenerationId = null;
  assertTrue(validatePresentationArtifact(a).some((e) => e.code === 'MOCK_UNDECLARED'), 'null sin mock');
  const b = validArtifact(); b.mock = true;
  assertTrue(validatePresentationArtifact(b).some((e) => e.code === 'MOCK_WITH_GENERATION'), 'mock con generación');
  const c = validArtifact(); c.themeModeAtGeneration = 'sepia';
  assertTrue(validatePresentationArtifact(c).some((e) => e.code === 'THEME_MODE'), 'modo inválido');
  const d = validArtifact(); d.themeModeAtGeneration = 'dark';
  assertEqual(validatePresentationArtifact(d).length, 0, 'modo válido');
});

// ── 9: mockPresentationArtifactFromFixture (E2E, nunca llama a Gamma) ───────
check('9: mockPresentationArtifactFromFixture — produce un artifact válido, gammaGenerationId null, mock:true', () => {
  for (const n of v1FixtureChapterNumbers()) {
    const { artifact } = mockPresentationArtifactFromFixture(`chapter-${n}`, n);
    const errors = validatePresentationArtifact(artifact);
    assertEqual(errors.length, 0, `cap${n}: artifact mock inválido: ${JSON.stringify(errors)}`);
    assertEqual(artifact.gammaGenerationId, null, `cap${n}: gammaGenerationId debe ser null`);
    assertEqual(artifact.mock, true, `cap${n}: mock debe ser true`);
    assertTrue(artifact.slideCount >= 1, `cap${n}: slideCount inválido`);
  }
});

check('9b: mockPresentationArtifactFromFixture — determinístico para el mismo fixtureIndex', () => {
  const a = mockPresentationArtifactFromFixture('chapter-x', 4, { generatedAt: '2026-01-01T00:00:00.000Z' });
  const b = mockPresentationArtifactFromFixture('chapter-x', 4, { generatedAt: '2026-01-01T00:00:00.000Z' });
  assertEqual(JSON.stringify(a.artifact), JSON.stringify(b.artifact), 'debe ser determinístico');
});

if (failures > 0) {
  console.error(`\n${failures} check(s) fallaron.`);
  process.exit(1);
}
console.log('\nTodos los checks de R9 (Gamma V2 presentation) pasaron.');
