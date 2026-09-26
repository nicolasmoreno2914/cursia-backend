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

const HEX_RE = /^#[0-9A-F]{6}$/;

function hueDiffDeg(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
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
  const t2 = resolveTheme({ ...defaultPresentationProfile(), themeVersion: 7 });
  assertEqual(t2.version, 7, 'version explícita');
});

console.log('');
if (failures > 0) {
  console.error(`❌ Theme Engine check FALLÓ (${failures} chequeo(s) roto(s)).`);
  process.exit(1);
}
console.log('✅ Theme Engine check OK.');
