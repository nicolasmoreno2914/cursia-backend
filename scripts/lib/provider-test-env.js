/* eslint-disable */
// Cursia V2.1 F2 — entorno FALSO de proveedores para los checks que crean runs
// v3 con Gamma/TTS reales congelados: el preflight de startRun (409
// provider_not_ready) exige que las claves y los themeIds EXISTAN. Estos
// valores nunca se usan para llamar a nadie (los checks corren bajo netguard;
// ningún test de estos archivos llega a un proveedor real).
'use strict';

const FAKE_PROVIDER_ENV = Object.freeze({
  GAMMA_API_KEY: 'fake-gamma-key-never-used-no-network',
  GAMMA_THEME_V21_LIGHT_DEFAULT: 'fake-gamma-theme-light',
  GAMMA_THEME_V21_DARK_DEFAULT: 'fake-gamma-theme-dark',
  OPENAI_API_KEY: 'fake-openai-key-never-used-no-network',
  ANTHROPIC_API_KEY: 'fake-anthropic-key-never-used-no-network',
});

/** Aplica el entorno falso y devuelve una función que restaura el anterior. */
function applyFakeProviderEnv(env = process.env) {
  const saved = {};
  for (const [k, v] of Object.entries(FAKE_PROVIDER_ENV)) {
    saved[k] = env[k];
    env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  };
}

module.exports = { FAKE_PROVIDER_ENV, applyFakeProviderEnv };
