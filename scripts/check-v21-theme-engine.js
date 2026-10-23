#!/usr/bin/env node
/* eslint-disable */
// R1 — Theme Engine acceptance check (v2.1). No-DB, no-network — pure
// function checks against the COMPILED module (never ts-node), same
// pattern as check-generation-manifest-determinism.js.
//
// Usage:
//   node scripts/check-v21-theme-engine.js [path/to/theme-engine/index.js]
// Default path: dist/modules/theme-engine/index.js

const fs = require('fs');
const path = require('path');

const modulePath = path.resolve(
  process.cwd(),
  process.argv[2] || 'dist/modules/theme-engine/index.js',
);

let te;
try {
  te = require(modulePath);
} catch (err) {
  console.error(`❌ No se pudo cargar el Theme Engine compilado en ${modulePath}`);
  console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
  console.error(`   ${err.message}`);
  process.exit(1);
}

const {
  THEME_ENGINE_VERSION,
  THEME_FAMILIES,
  resolveTheme,
  validateTheme,
  moduleColor,
  themeSha256,
  contrastRatio,
  relativeLuminance,
  defaultPresentationProfile,
  brandSeedFromLegacyPalette,
  legacyPaletteThemeFallback,
} = te;

for (const [name, val] of Object.entries({
  THEME_ENGINE_VERSION,
  THEME_FAMILIES,
  resolveTheme,
  validateTheme,
  moduleColor,
  themeSha256,
  contrastRatio,
  relativeLuminance,
  defaultPresentationProfile,
  brandSeedFromLegacyPalette,
  legacyPaletteThemeFallback,
})) {
  if (val === undefined) {
    console.error(`❌ El Theme Engine compilado en ${modulePath} no exporta "${name}".`);
    process.exit(1);
  }
}

const fixturePath = path.resolve(process.cwd(), 'scripts/fixtures/v21-legacy-palettes.json');
let LEGACY_PALETTES;
try {
  LEGACY_PALETTES = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
} catch (err) {
  console.error(`❌ No se pudo leer el fixture de paletas legacy en ${fixturePath}`);
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
    console.error(`   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
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
function eqJson(actual, expected, msg) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
}

const HEX_RE = /^#[0-9A-F]{6}$/;

function hueDiffDeg(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}
function hexSat(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return 0;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

function hexToHueDeg(hex) {
  const h = hex.slice(1);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let hue;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) hue = ((b - r) / d + 2) * 60;
  else hue = ((r - g) / d + 4) * 60;
  return hue;
}

function walkHexValues(obj, out) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (const v of obj) walkHexValues(v, out);
    return;
  }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) walkHexValues(v, out);
    return;
  }
  if (typeof obj === 'string' && obj.startsWith('#')) out.push(obj);
}

const allSeeds = [
  { label: '(sin seed)', seed: undefined },
  ...LEGACY_PALETTES.map((p) => ({ label: p.id, seed: brandSeedFromLegacyPalette(p) })),
];
assertEqual(LEGACY_PALETTES.length, 28, 'fixture debe tener las 28 paletas legacy');

// ── 1 + 6 + 7 + 9: cada familia × modo soportado × {sin seed, cada una de las 28 semillas} ──
check(
  '1/6/7/9: cada familia × modo × (sin seed + 28 semillas legacy) resuelve y pasa validateTheme (moduleCount 1..12); luminancia de bg correcta; tipografía; adjustments con seed problemática',
  () => {
    let combos = 0;
    let yellowAdjustmentSeen = false;
    for (const familyId of Object.keys(THEME_FAMILIES)) {
      const family = THEME_FAMILIES[familyId];
      for (const mode of family.supportedModes) {
        for (const { label, seed } of allSeeds) {
          combos++;
          const theme = resolveTheme({ themeFamily: familyId, mode, brandSeed: seed });
          for (const moduleCount of [1, 3, 7, 12]) {
            const errors = validateTheme(theme, { moduleCount });
            assertTrue(
              errors.length === 0,
              `${familyId}/${mode}/seed=${label} moduleCount=${moduleCount}: ${errors.map((e) => `[${e.code}] ${e.message}`).join('; ')}`,
            );
          }
          if (mode === 'light') {
            assertTrue(
              relativeLuminance(theme.color.bg) > 0.8,
              `${familyId}/light/seed=${label}: bg debe tener luminancia > 0.8 (${relativeLuminance(theme.color.bg)})`,
            );
          } else {
            assertTrue(
              relativeLuminance(theme.color.bg) < 0.05,
              `${familyId}/dark/seed=${label}: bg debe tener luminancia < 0.05 (${relativeLuminance(theme.color.bg)})`,
            );
          }
          assertEqual(theme.typography.sizeBodyPx, 18, `${familyId}/${mode}: sizeBodyPx`);
          assertTrue(theme.typography.sizeSmallPx >= 16, `${familyId}/${mode}: sizeSmallPx >= 16`);
        }
      }
    }
    assertTrue(combos > 0, 'debió iterar al menos una combinación');

    // Semilla amarilla (#FFFF00) sobre una familia clara fuerza corrección.
    const yellowTheme = resolveTheme({
      themeFamily: 'aula-clara',
      mode: 'light',
      brandSeed: { accent: '#FFFF00' },
    });
    yellowAdjustmentSeen = yellowTheme.adjustments.length > 0;
    assertTrue(yellowAdjustmentSeen, 'seed accent #FFFF00 sobre aula-clara/light debe forzar al menos un adjustment');
  },
);

// ── 6 familias, defaults y modos soportados exactos ──
check('familias: exactamente 6, con los modos soportados exigidos por el brief', () => {
  const ids = Object.keys(THEME_FAMILIES).sort();
  assertEqual(
    ids.join(','),
    ['aula-clara', 'editorial', 'institucional', 'oscuro-premium', 'tecnico', 'vibrante'].sort().join(','),
    'ids de familia',
  );
  assertTrue(THEME_FAMILIES['aula-clara'].supportedModes.includes('light'), 'aula-clara soporta light');
  assertTrue(THEME_FAMILIES['institucional'].supportedModes.includes('light'), 'institucional soporta light');
  assertTrue(THEME_FAMILIES['editorial'].supportedModes.includes('light'), 'editorial soporta light');
  assertTrue(THEME_FAMILIES['vibrante'].supportedModes.includes('light'), 'vibrante soporta light');
  assertTrue(
    THEME_FAMILIES['tecnico'].supportedModes.includes('light') && THEME_FAMILIES['tecnico'].supportedModes.includes('dark'),
    'tecnico soporta light + dark',
  );
  assertEqual(THEME_FAMILIES['oscuro-premium'].supportedModes.join(','), 'dark', 'oscuro-premium solo soporta dark');
  const def = defaultPresentationProfile();
  assertEqual(def.themeFamily, 'aula-clara', 'perfil default: familia');
  assertEqual(def.mode, 'light', 'perfil default: modo');
});

// ── 2: determinismo ──
check('2: determinismo — mismo input → mismo JSON/sha; distinto seed → distinto sha', () => {
  const a1 = resolveTheme({ themeFamily: 'aula-clara', mode: 'light' });
  const a2 = resolveTheme({ themeFamily: 'aula-clara', mode: 'light' });
  assertEqual(JSON.stringify(a1), JSON.stringify(a2), 'JSON idéntico para el mismo input');
  assertEqual(themeSha256(a1), themeSha256(a2), 'sha idéntico para el mismo input');

  const seeded = resolveTheme({
    themeFamily: 'aula-clara',
    mode: 'light',
    brandSeed: { accent: '#123456' },
  });
  assertTrue(themeSha256(seeded) !== themeSha256(a1), 'distinto seed debe producir distinto sha');
  const seededModules = resolveTheme({ themeFamily: 'aula-clara', mode: 'light', brandSeed: { moduleColors: ['#2563EB'] } });
  assertTrue(themeSha256(seededModules) !== themeSha256(a1), 'seed solo de módulos debe cambiar el sha');
  assertTrue(moduleColor(seededModules, 0).main !== moduleColor(a1, 0).main, 'seed de módulos llega a moduleColor(0)');
});

// ── 3: moduleColor para N = 1..12 ──
check('3: moduleColor(N=1..12) — main distintos y vecinos difieren en contraste ≥1.2 o en tono', () => {
  for (const familyId of Object.keys(THEME_FAMILIES)) {
    const family = THEME_FAMILIES[familyId];
    for (const mode of family.supportedModes) {
      for (const { label, seed } of allSeeds) {
        const theme = resolveTheme({ themeFamily: familyId, mode, brandSeed: seed });
        const colors = [];
        for (let i = 0; i < 12; i++) colors.push(moduleColor(theme, i));
        const mains = colors.map((c) => c.main);
        assertEqual(
          new Set(mains).size,
          mains.length,
          `${familyId}/${mode}/seed=${label}: los 12 main deben ser distintos entre sí (${mains.join(',')})`,
        );
        for (let i = 1; i < mains.length; i++) {
          const ratio = contrastRatio(mains[i], mains[i - 1]);
          const hueDiff = hueDiffDeg(hexToHueDeg(mains[i]), hexToHueDeg(mains[i - 1]));
          assertTrue(
            ratio >= 1.2 || hueDiff >= 20,
            `${familyId}/${mode}/seed=${label}: moduleColor(${i - 1})=${mains[i - 1]} y moduleColor(${i})=${mains[i]} son demasiado parecidos (contraste ${ratio.toFixed(2)}, Δtono ${hueDiff.toFixed(1)}°)`,
          );
        }
      }
    }
  }
});

// ── 4: modo no soportado → throw THEME_INVALID ──
check('4: modo no soportado por la familia → throw THEME_INVALID', () => {
  let threw = false;
  try {
    resolveTheme({ themeFamily: 'aula-clara', mode: 'dark' });
  } catch (err) {
    threw = true;
    assertTrue(/^THEME_INVALID:/.test(err.message), `mensaje debe empezar con THEME_INVALID: (${err.message})`);
  }
  assertTrue(threw, 'aula-clara/dark debe lanzar (aula-clara solo soporta light)');

  threw = false;
  try {
    resolveTheme({ themeFamily: 'oscuro-premium', mode: 'light' });
  } catch (err) {
    threw = true;
    assertTrue(/^THEME_INVALID:/.test(err.message), 'oscuro-premium/light: mensaje THEME_INVALID');
  }
  assertTrue(threw, 'oscuro-premium/light debe lanzar (oscuro-premium solo soporta dark)');
});

// ── 5: todos los colores emitidos son hex uppercase de 6 dígitos ──
check('5: todos los colores emitidos (walk completo del objeto) son hex uppercase de 6 dígitos', () => {
  let sampled = 0;
  for (const familyId of Object.keys(THEME_FAMILIES)) {
    const family = THEME_FAMILIES[familyId];
    for (const mode of family.supportedModes) {
      for (const { seed } of allSeeds) {
        const theme = resolveTheme({ themeFamily: familyId, mode, brandSeed: seed });
        const hexes = [];
        walkHexValues(theme, hexes);
        for (let i = 0; i < 12; i++) walkHexValues(moduleColor(theme, i), hexes);
        assertTrue(hexes.length > 0, `${familyId}/${mode}: debería haber colores hex en el tema`);
        for (const hex of hexes) {
          assertTrue(HEX_RE.test(hex), `color "${hex}" no es #RRGGBB uppercase (familia ${familyId}/${mode})`);
        }
        sampled += hexes.length;
      }
    }
  }
  assertTrue(sampled > 100, 'debieron muestrearse muchos valores hex');
});

// ── 8: contrastRatio valores conocidos ──
check('8: contrastRatio — negro/blanco = 21, mismo color = 1', () => {
  assertEqual(contrastRatio('#000000', '#FFFFFF'), 21, 'negro vs blanco');
  assertEqual(contrastRatio('#3366CC', '#3366CC'), 1, 'mismo color');
  assertEqual(contrastRatio('#FFFFFF', '#000000'), 21, 'orden invertido, mismo resultado');
});

// ── brandSeedFromLegacyPalette / legacyPaletteThemeFallback ──
check('brandSeedFromLegacyPalette + legacyPaletteThemeFallback: seed correcto, tema válido, id desconocido → throw', () => {
  const p = LEGACY_PALETTES.find((x) => x.id === 'navy-teal');
  const seed = brandSeedFromLegacyPalette(p);
  assertEqual(seed.accent, '#E8692A', 'accent de navy-teal');
  assertEqual(seed.moduleColors.join(','), [p.m1, p.m2, p.m3].join(','), 'moduleColors = [m1,m2,m3]');

  const profile = legacyPaletteThemeFallback('navy-teal');
  assertEqual(profile.themeFamily, 'oscuro-premium', 'fallback: familia');
  assertEqual(profile.mode, 'dark', 'fallback: modo');
  const theme = resolveTheme(profile);
  assertEqual(validateTheme(theme).length, 0, 'el tema del fallback debe ser válido');

  let threw = false;
  try {
    legacyPaletteThemeFallback('esto-no-existe');
  } catch (err) {
    threw = true;
    assertTrue(/^THEME_INVALID:/.test(err.message), 'paleta desconocida: mensaje THEME_INVALID');
  }
  assertTrue(threw, 'paleta legacy desconocida debe lanzar');
});

// ── THEME_ENGINE_VERSION / version en el tema resuelto ──
check('THEME_ENGINE_VERSION === 1 y ResolvedTheme.version usa themeVersion o el default', () => {
  assertEqual(THEME_ENGINE_VERSION, 1, 'THEME_ENGINE_VERSION');
  const t = resolveTheme(defaultPresentationProfile());
  assertEqual(t.version, 1, 'version por defecto');
  const t1 = resolveTheme({ ...defaultPresentationProfile(), themeVersion: 1 });
  assertEqual(t1.version, 1, 'themeVersion 1 explícita');
  for (const bad of [7, 0, 2, '1']) {
    let threw = false;
    try {
      resolveTheme({ ...defaultPresentationProfile(), themeVersion: bad });
    } catch (err) {
      threw = /^THEME_INVALID:/.test(err.message);
    }
    assertTrue(threw, `themeVersion ${JSON.stringify(bad)} debe lanzar THEME_INVALID`);
  }
  assertTrue(validateTheme({ ...t, version: 9 }).some((e) => e.code === 'VERSION'), 'validateTheme rechaza version ≠ motor');
});

// ── Fix round 1 / I3: la BrandSeed de módulos se respeta en orden ──
check('I3: seed rojo/azul/verde → módulos 0/1/2 rojo/azul/verde (Δtono ≤ 10°), en todas las familias', () => {
  const seedColors = ['#E11D48', '#2563EB', '#16A34A'];
  for (const familyId of Object.keys(THEME_FAMILIES)) {
    for (const mode of THEME_FAMILIES[familyId].supportedModes) {
      const theme = resolveTheme({ themeFamily: familyId, mode, brandSeed: { moduleColors: seedColors } });
      seedColors.forEach((sc, i) => {
        const main = moduleColor(theme, i).main;
        const d = hueDiffDeg(hexToHueDeg(main), hexToHueDeg(sc));
        assertTrue(d <= 10, `${familyId}/${mode}: módulo ${i} ${main} vs seed ${sc} Δtono ${d.toFixed(1)}°`);
      });
      // más allá de las anclas sigue habiendo colores distintos
      const mains = Array.from({ length: 12 }, (_, i) => moduleColor(theme, i).main);
      assertEqual(new Set(mains).size, 12, `${familyId}/${mode}: 12 módulos distintos`);
    }
  }
});

check('I3: paletas legacy conservan el orden de tonos m1/m2/m3 (anclas no neutras)', () => {
  let checked = 0;
  for (const p of LEGACY_PALETTES) {
    const theme = resolveTheme(legacyPaletteThemeFallback(p.id));
    const notes = te.moduleColorAdjustments(theme, 3);
    [p.m1, p.m2, p.m3].forEach((m, i) => {
      const anchor = m.toUpperCase();
      const sat = hexSat(anchor);
      const collided = notes.some((n) => n.startsWith(`moduleColor(${i}).main ajustado`));
      if (sat < 0.2 || collided) return;
      const main = moduleColor(theme, i).main;
      const d = hueDiffDeg(hexToHueDeg(main), hexToHueDeg(anchor));
      assertTrue(d <= 10, `${p.id}: m${i + 1} ${anchor} → módulo ${i} ${main} (Δtono ${d.toFixed(1)}°)`);
      checked++;
    });
  }
  assertTrue(checked >= 60, `pocas anclas verificadas: ${checked}`);
});

check('I3/M5: correcciones de color de módulo quedan en adjustments y en moduleColorAdjustments', () => {
  // gris de luminancia ~0.19: ni el casi-blanco ni el casi-negro alcanzan 4.5 → hay corrección
  const theme = resolveTheme({ themeFamily: 'aula-clara', mode: 'light', brandSeed: { moduleColors: ['#797979', '#2563EB'] } });
  const notes = te.moduleColorAdjustments(theme, 2);
  assertTrue(notes.some((n) => n.startsWith('moduleColor(0).main corregido')), `nota de corrección: ${JSON.stringify(notes)}`);
  assertTrue(theme.adjustments.some((n) => n.startsWith('moduleColor(0).main corregido')), `adjustments: ${JSON.stringify(theme.adjustments)}`);
  assertTrue(te.moduleColorAdjustments(resolveTheme({ themeFamily: 'aula-clara', mode: 'light', brandSeed: { moduleColors: ['#2563EB'] } }), 1).length === 0, 'sin corrección, sin nota');
});

check('M3: ningún color emitido es #FFFFFF/#000000 puro; una seed pura se sustituye y se registra', () => {
  for (const familyId of Object.keys(THEME_FAMILIES)) {
    for (const mode of THEME_FAMILIES[familyId].supportedModes) {
      for (const { label, seed } of allSeeds) {
        const theme = resolveTheme({ themeFamily: familyId, mode, brandSeed: seed });
        const hexes = [];
        walkHexValues(theme, hexes);
        for (let i = 0; i < 12; i++) walkHexValues(moduleColor(theme, i), hexes);
        for (const h of hexes) assertTrue(h !== '#FFFFFF' && h !== '#000000', `${familyId}/${mode}/${label}: ${h}`);
      }
    }
  }
  const t = resolveTheme({ themeFamily: 'aula-clara', mode: 'light', brandSeed: { accent: '#000000', moduleColors: ['#FFFFFF', '#2563EB'] } });
  assertTrue(t.color.accent !== '#000000' && t.adjustments.some((a) => a.includes('brandSeed.accent')), 'accent puro sustituido');
  assertTrue(t.moduleColorsBasis[0] !== '#FFFFFF' && t.adjustments.some((a) => a.includes('brandSeed.moduleColors[0]')), 'módulo puro sustituido');
  const bad = { ...t, color: { ...t.color, surface: '#FFFFFF' } };
  assertTrue(validateTheme(bad).some((e) => e.code === 'PURE_BLACK_WHITE'), 'validateTheme detecta blanco puro');
});

// ─── P3 — sistema visual educativo 2.0: tonos por rol pedagógico ────────────
check('P3: blocks — 8 roles en todo tema resuelto; ink ≥ 4.5 sobre soft/bg/surface, textPrimary ≥ 4.5 sobre soft, onInk ≥ 4.5 sobre ink', () => {
  const roles = te.EDU_BLOCK_ROLES;
  assertTrue(Array.isArray(roles) && roles.join(',') === 'concepto,ejemplo,caso,error,proceso,decision,reflexion,visual', 'EDU_BLOCK_ROLES');
  for (const familyId of Object.keys(THEME_FAMILIES)) {
    for (const mode of THEME_FAMILIES[familyId].supportedModes) {
      const t = resolveTheme({ themeFamily: familyId, mode });
      assertTrue(t.blocks && Object.keys(t.blocks).length === roles.length, `${familyId}/${mode}: blocks`);
      for (const r of roles) {
        const b = t.blocks[r];
        assertTrue(contrastRatio(b.ink, b.soft) >= 4.5 && contrastRatio(b.ink, t.color.bg) >= 4.5 && contrastRatio(b.ink, t.color.surface) >= 4.5, `${familyId}/${mode}/${r}: ink`);
        assertTrue(contrastRatio(t.color.textPrimary, b.soft) >= 4.5, `${familyId}/${mode}/${r}: textPrimary sobre soft`);
        assertTrue(contrastRatio(b.onInk, b.ink) >= 4.5, `${familyId}/${mode}/${r}: onInk`);
      }
      // semánticos: mismos tonos en todas las familias de un modo
      eqJson(Object.fromEntries(roles.map((r) => [r, { ink: t.blocks[r].ink, soft: t.blocks[r].soft, edge: t.blocks[r].edge }])), te.EDU_BLOCKS[mode], `${familyId}/${mode}: EDU_BLOCKS`);
    }
  }
  const t = resolveTheme({ themeFamily: 'aula-clara', mode: 'light' });
  const bad = { ...t, blocks: { ...t.blocks, error: { ...t.blocks.error, ink: '#F2C3BD' } } };
  assertTrue(validateTheme(bad).some((e) => e.code === 'CONTRAST_TOO_LOW' && e.message.includes('blocks.error.ink')), 'validateTheme detecta un ink ilegible');
});

check('P3: tipografía de curso — display ≤ 32 px base, sin cursiva de tesis; Oscuro Premium en sans humanista', () => {
  for (const familyId of Object.keys(THEME_FAMILIES)) {
    for (const mode of THEME_FAMILIES[familyId].supportedModes) {
      const t = resolveTheme({ themeFamily: familyId, mode });
      assertTrue(t.typography.sizeDisplayPx === 32 && t.typography.sizeTitlePx === 24 && t.typography.sizeBodyPx === 18, `${familyId}/${mode}: escala`);
      assertTrue(t.personality.thesisItalic === false, `${familyId}/${mode}: sin cursiva de tesis`);
    }
  }
  const op = resolveTheme({ themeFamily: 'oscuro-premium', mode: 'dark' });
  assertTrue(!/serif/i.test(op.personality.fontDisplay.replace(/sans-serif/g, '')) && !/serif/i.test(op.typography.fontBody.replace(/sans-serif/g, '')), 'Oscuro Premium sin serif');
  eqJson(te.defaultPresentationProfile(), { themeFamily: 'aula-clara', mode: 'light' }, 'default de cursos nuevos: Aula Clara claro');
});

check('P3 (fix I1 / I1-R1 / I1-R2): colores de MARCA intactos; los de Cursia (anclas por defecto y generados) fuera de los tonos de rol, sin verde y a ΔE2000 ≥ 20 de todo rol', () => {
  const D = te.ROLE_HUE_MIN_DISTANCE;
  const DE = te.DEFAULT_MODULE_MIN_DELTA_E;
  assertEqual(`${D}/${DE}`, '25/20', 'umbrales');
  const sat = (hex) => { const n = parseInt(hex.slice(1), 16); const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2; return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); };
  const VCE = require(path.resolve(process.cwd(), 'dist/modules/visual-components/edu.js'));
  // (1) anclas por defecto de cada familia: role-safe, sin verde (ejemplo) y ΔE2000 ≥ 20 (main, ink y relleno de moduleTone)
  for (const familyId of Object.keys(THEME_FAMILIES)) {
    for (const mode of THEME_FAMILIES[familyId].supportedModes) {
      const t = resolveTheme({ themeFamily: familyId, mode });
      assertEqual(t.moduleColorsSource, 'family', `${familyId}/${mode}: fuente`);
      assertTrue(validateTheme(t).length === 0, `${familyId}/${mode}: ${JSON.stringify(validateTheme(t))}`);
      const g = t.personality.plate ? t.color.bg : t.color.surface;
      for (let i = 0; i < 12; i++) {
        const mc = moduleColor(t, i);
        assertTrue(sat(mc.main) < te.MODULE_NEUTRAL_SAT || te.roleHueDistance(t, mc.main) >= D, `${familyId}/${mode}: módulo ${i} ${mc.main} en tono de rol`);
        // fix I1-R3: anclas Y módulos generados (1–12) cumplen lo mismo
        const k = VCE.moduleTone(t, mc, g);
        const hue = hexToHueDeg(mc.main);
        assertTrue(sat(mc.main) < te.MODULE_NEUTRAL_SAT || hue < 80 || hue > 175, `${familyId}/${mode}: módulo ${i} ${mc.main} es verde`);
        // distinto del módulo anterior (ΔE ≥ 10) y nunca repetido
        if (i > 0) assertTrue(te.deltaE2000(mc.main, moduleColor(t, i - 1).main) >= 10, `${familyId}/${mode}: módulo ${i} ${mc.main} ≈ módulo ${i - 1}`);
        for (let j = 0; j < i; j++) assertTrue(mc.main !== moduleColor(t, j).main, `${familyId}/${mode}: módulo ${i} repite el ${j}`);
        for (const [role, b] of Object.entries(t.blocks)) {
          for (const x of [mc.main, k.ink, k.fill]) assertTrue(te.deltaE2000(x, b.ink) >= DE, `${familyId}/${mode}: ancla ${i} ${x} a ΔE ${te.deltaE2000(x, b.ink).toFixed(1)} de ${role}`);
        }
      }
    }
  }
  // (2) la paleta por defecto de cursos nuevos (aula-clara) cumple lo mismo (es semilla, así que nunca se toca)
  const ac = LEGACY_PALETTES.find((p) => p.id === 'aula-clara');
  const tac = resolveTheme(te.presentationProfileFromPaletteId('aula-clara'));
  [ac.m1, ac.m2, ac.m3].forEach((m, i) => {
    assertEqual(moduleColor(tac, i).main, m.toUpperCase(), `aula-clara m${i + 1} intacto`);
    for (const [role, b] of Object.entries(tac.blocks)) assertTrue(te.deltaE2000(m, b.ink) >= DE && (te.roleHueDistance(tac, m) >= D || sat(m) < te.MODULE_NEUTRAL_SAT), `aula-clara m${i + 1} ${m} cerca de ${role}`);
    const h = hexToHueDeg(m);
    assertTrue(h < 80 || h > 175, `aula-clara m${i + 1} ${m} es verde`);
  });
  // (3) I1-R1: los colores de MARCA nunca cambian por pedagogía — las 28 paletas legacy conservan sus colores
  // de módulo exactos (salvo la corrección de contraste de siempre, que conserva el tono).
  let exact = 0;
  for (const p of LEGACY_PALETTES) {
    const t = resolveTheme(te.presentationProfileFromPaletteId(p.id));
    assertEqual(t.moduleColorsSource, 'brand', `${p.id}: fuente marca`);
    assertTrue(!t.adjustments.some((a) => /desplazado fuera de los tonos de rol/.test(a)), `${p.id}: semilla desplazada (${t.adjustments.join(' | ')})`);
    const notes = te.moduleColorAdjustments(t, 3);
    [p.m1, p.m2, p.m3].forEach((m, i) => {
      const main = moduleColor(t, i).main;
      const corrected = notes.some((n) => n.startsWith(`moduleColor(${i}).main`));
      if (!corrected) { assertEqual(main, m.toUpperCase(), `${p.id}: m${i + 1}`); exact++; } else assertTrue(hueDiffDeg(hexToHueDeg(main), hexToHueDeg(m)) <= 10, `${p.id}: m${i + 1} corregido solo en contraste`);
    });
  }
  assertTrue(exact >= 60, `pocos colores exactos: ${exact}`);
  const navy = resolveTheme(te.presentationProfileFromPaletteId('navy-teal'));
  assertEqual(moduleColor(navy, 0).main, '#1A3C5E', 'navy-teal (#413) conserva el navy');
  // (4b) fix I1-R3: paleta de marca de 3 colores (navy-teal, berry): módulos 1–3 intactos, 4–12 generados por
  // Cursia a ΔE2000 ≥ 20 de todo rol (main, ink y relleno), sin verde y distintos de los anteriores.
  for (const pid of ['navy-teal', 'berry']) {
    const t = resolveTheme(te.presentationProfileFromPaletteId(pid));
    const p = LEGACY_PALETTES.find((x) => x.id === pid);
    const g = t.personality.plate ? t.color.bg : t.color.surface;
    for (let i = 3; i < 12; i++) {
      const mc = moduleColor(t, i);
      const k = VCE.moduleTone(t, mc, g);
      for (const [role, b] of Object.entries(t.blocks)) for (const x of [mc.main, k.ink, k.fill]) assertTrue(te.deltaE2000(x, b.ink) >= DE, `${pid}: módulo ${i + 1} ${x} a ΔE ${te.deltaE2000(x, b.ink).toFixed(1)} de ${role}`);
      const h = hexToHueDeg(mc.main);
      assertTrue(sat(mc.main) < te.MODULE_NEUTRAL_SAT || h < 80 || h > 175, `${pid}: módulo ${i + 1} ${mc.main} es verde`);
      assertTrue(te.deltaE2000(mc.main, moduleColor(t, i - 1).main) >= 10, `${pid}: módulo ${i + 1} ≈ módulo ${i}`);
      for (let j = 0; j < i; j++) assertTrue(mc.main !== moduleColor(t, j).main, `${pid}: módulo ${i + 1} repite el ${j + 1}`);
    }
    assertTrue(validateTheme(t).length === 0, `${pid}: ${JSON.stringify(validateTheme(t))}`);
    void p;
  }
  // (4) módulos GENERADOS más allá de la marca: de Cursia → fuera de los tonos de rol
  const seeded = resolveTheme({ themeFamily: 'aula-clara', mode: 'light', brandSeed: { moduleColors: ['#1E3A8A', '#C8102E'] } });
  eqJson([moduleColor(seeded, 0).main, moduleColor(seeded, 1).main], ['#1E3A8A', '#C8102E'], 'marca intacta');
  for (let i = 2; i < 12; i++) { const m = moduleColor(seeded, i).main; assertTrue(sat(m) < te.MODULE_NEUTRAL_SAT || te.roleHueDistance(seeded, m) >= D, `generado ${i} ${m} en tono de rol`); }
  // determinismo + 500 semillas: nunca falla, la marca queda intacta
  let x = 12345;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let k = 0; k < 500; k++) {
    const hex = () => '#' + Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0').toUpperCase();
    const fam = Object.keys(THEME_FAMILIES)[k % 6];
    const mode = THEME_FAMILIES[fam].supportedModes[k % THEME_FAMILIES[fam].supportedModes.length];
    const t = resolveTheme({ themeFamily: fam, mode, brandSeed: { moduleColors: [hex(), hex()] } });
    assertTrue(!t.adjustments.some((a) => /desplazado fuera de los tonos de rol/.test(a) && /moduleColor\([01]\)/.test(a)), `semilla ${k}: marca desplazada`);
    for (let i = 2; i < 6; i++) { const m = moduleColor(t, i).main; assertTrue(sat(m) < te.MODULE_NEUTRAL_SAT || te.roleHueDistance(t, m) >= D, `semilla ${k}: generado ${i} ${m}`); }
  }
  // validateTheme detecta un ancla por defecto perceptualmente cerca de un rol
  const t0 = resolveTheme({ themeFamily: 'aula-clara', mode: 'light' });
  assertTrue(validateTheme({ ...t0, moduleColorsBasis: ['#13683A', ...t0.moduleColorsBasis.slice(1)] }).some((e) => e.code === 'MODULE_ROLE_DELTAE' || e.code === 'MODULE_ROLE_HUE'), 'MODULE_ROLE_DELTAE');
  assertTrue(te.roleHueDistance(t0, '#1D4FB8') < 1 && te.deltaE2000('#FFFFFF', '#000000') > 99, 'utilidades');
});

console.log('');
if (failures > 0) {
  console.error(`❌ Theme Engine check FALLÓ (${failures} chequeo(s) roto(s)).`);
  process.exit(1);
}
console.log('✅ Theme Engine check OK.');
