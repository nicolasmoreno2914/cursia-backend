#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 / R7-core — preflight de librerías H5P contra un Moodle real
// (HD-V21-15, fail loud). Ejecuta el CLI de Moodle
// `scripts/moodle/h5p-installed-libraries.php` (solo lectura), aplica
// CURSIA_H5P_PROFILE_V1 y sale con código != 0 si falta alguna librería o si
// alguna tiene un patch menor al del perfil.
//
// Uso (después de `npm run build`):
//   node scripts/h5p-preflight-moodle.js <moodleDir> <phpIni> [--scope runtime|full]
// <moodleDir> es la carpeta con config.php. PHP: env PHP_BIN (default "php").

const path = require('path');
const { execFileSync } = require('child_process');

function runPreflight(moodleDir, phpIni, scope = 'full') {
  const h = require(path.resolve(__dirname, '..', 'dist/package/h5p/index.js'));
  const php = process.env.PHP_BIN || 'php';
  const script = path.resolve(__dirname, 'moodle/h5p-installed-libraries.php');
  const args = [...(phpIni ? ['-c', phpIni] : []), script, moodleDir];
  const out = execFileSync(php, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const line = out.trim().split('\n').filter(Boolean).pop();
  const data = JSON.parse(line);
  const result = h.h5pPreflight(h.CURSIA_H5P_PROFILE_V1, data.libraries, { scope });
  return { data, result, h };
}

module.exports = { runPreflight };

if (require.main === module) {
  const args = process.argv.slice(2);
  const [moodleDir, phpIni] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--scope');
  const si = args.indexOf('--scope');
  const scope = si >= 0 ? args[si + 1] : 'full';
  if (!moodleDir) {
    console.error('uso: node scripts/h5p-preflight-moodle.js <moodleDir> <phpIni> [--scope runtime|full]');
    process.exit(2);
  }
  try {
    const { data, result, h } = runPreflight(moodleDir, phpIni, scope);
    console.log(`Moodle ${data.moodleRelease}: ${data.libraries.length} librerías H5P instaladas; perfil ${h.CURSIA_H5P_PROFILE_V1.profileId} exige ${result.required.length} (${scope})`);
    h.assertH5pPreflight(h.CURSIA_H5P_PROFILE_V1, data.libraries, { scope });
    console.log(`✅ preflight H5P OK: ${result.satisfied.length}/${result.required.length} librerías compatibles`);
  } catch (err) {
    console.error(`❌ ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}
