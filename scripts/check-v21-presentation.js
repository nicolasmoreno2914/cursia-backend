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

check('3: presentationCardHtml — pasa el lint CLEAN_SAFE mínimo (claro y oscuro)', () => {
  for (const theme of [lightTheme, darkTheme]) {
    const html = buildCard(theme, 12);
    const violations = lintCleanSafeMinimal(html);
    assertEqual(violations.length, 0, `violaciones CLEAN_SAFE: ${JSON.stringify(violations)}`);
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

check('4b: presentationCardHtml — escapa HTML en el título (alt e img)', () => {
  const html = buildCard(lightTheme, 5);
  assertTrue(!html.includes('<raros>'), 'no debe inyectar HTML crudo del título');
  assertTrue(html.includes('&lt;raros&gt;'), 'el título debe quedar HTML-escapado');
});

check('4c: presentationCardHtml — responsive a 390px (imagen max-width/width sin height fijo en la parte safe)', () => {
  const html = buildCard(lightTheme, 5);
  const imgMatch = html.match(/<img[^>]*style="([^"]*)"/);
  assertTrue(!!imgMatch, 'debe haber un <img>');
  const style = imgMatch[1];
  assertTrue(/max-width:100%/.test(style), 'max-width:100%');
  assertTrue(/width:100%/.test(style), 'width:100%');
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

check('7: themeMismatch — misma familia no genera aviso; familia distinta sí', () => {
  const same = themeMismatch('aula-clara', 'aula-clara');
  assertEqual(same.mismatch, false, 'misma familia => sin mismatch');
  assertTrue(same.warning === undefined, 'sin warning cuando no hay mismatch');

  const diff = themeMismatch('aula-clara', 'oscuro-premium');
  assertEqual(diff.mismatch, true, 'familia distinta => mismatch');
  assertEqual(diff.warning, 'theme_mismatch', 'warning debe ser theme_mismatch');
});

// ── 8: validatePresentationArtifact ─────────────────────────────────────────
function validArtifact() {
  return {
    schemaVersion: 1,
    chapterId: 'chapter-uuid-1',
    gammaGenerationId: null,
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
