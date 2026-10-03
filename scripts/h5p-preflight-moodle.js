#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 / R7-core — preflight de librerías H5P contra un Moodle real
// (HD-V21-15, fail loud). Ejecuta el CLI de Moodle
// `scripts/moodle/h5p-installed-libraries.php` (solo lectura), aplica
// CURSIA_H5P_PROFILE_V1 y sale con código != 0 si falta alguna librería o si
// alguna tiene un patch menor al del perfil, o si una librería principal del
// perfil está deshabilitada en el sitio (mdl_h5p_libraries.enabled = 0).
//
// Uso (después de `npm run build`):
//   node scripts/h5p-preflight-moodle.js <moodleDir> <phpIni> [--scope runtime|full] [--profile v1|v2]
//
// EV6 H5P v2: `--profile v2` exige CURSIA_H5P_PROFILE_V2 (v1 + Branching Scenario + Dialog Cards).
// Un sitio solo lo necesita si un DOCENTE va a restaurar cursos con esos tipos (con restauración de
// administrador o gestor, los paquetes instalan sus librerías solos); el default sigue siendo v1.
// UX #5 (r18): `--profile v3` = v2 con QuestionSet 1.21 (la actividad por defecto de los cursos nuevos).
// <moodleDir> es la carpeta con config.php. PHP: env PHP_BIN (default "php").

const path = require('path');
const { execFileSync } = require('child_process');

function runPreflight(moodleDir, phpIni, scope = 'full', profileName = 'v1') {
  const h = require(path.resolve(__dirname, '..', 'dist/package/h5p/index.js'));
  const profile = { v1: h.CURSIA_H5P_PROFILE_V1, v2: h.CURSIA_H5P_PROFILE_V2, v3: h.CURSIA_H5P_PROFILE_V3 }[profileName];
  if (!profile) throw new Error(`perfil desconocido: ${profileName}`);
  const php = process.env.PHP_BIN || 'php';
  const script = path.resolve(__dirname, 'moodle/h5p-installed-libraries.php');
  const args = [...(phpIni ? ['-c', phpIni] : []), script, moodleDir];
  const out = execFileSync(php, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const line = out.trim().split('\n').filter(Boolean).pop();
  const data = JSON.parse(line);
  const result = h.h5pPreflight(profile, data.libraries, { scope });
  return { data, result, h, profile };
}

module.exports = { runPreflight };

if (require.main === module) {
  const args = process.argv.slice(2);
  const [moodleDir, phpIni] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--scope' && args[i - 1] !== '--profile');
  const si = args.indexOf('--scope');
  const scope = si >= 0 ? args[si + 1] : 'full';
  const pi = args.indexOf('--profile');
  const profileName = pi >= 0 ? args[pi + 1] : 'v1';
  if (!moodleDir || !['v1', 'v2', 'v3'].includes(profileName)) {
    console.error('uso: node scripts/h5p-preflight-moodle.js <moodleDir> <phpIni> [--scope runtime|full] [--profile v1|v2|v3]');
    process.exit(2);
  }
  try {
    const { data, result, h, profile } = runPreflight(moodleDir, phpIni, scope, profileName);
    console.log(`Moodle ${data.moodleRelease}: ${data.libraries.length} librerías H5P instaladas; perfil ${profile.profileId} exige ${result.required.length} (${scope})`);
    h.assertH5pPreflight(profile, data.libraries, { scope });
    console.log(`✅ preflight H5P OK: ${result.satisfied.length}/${result.required.length} librerías compatibles`);
  } catch (err) {
    console.error(`❌ ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}
