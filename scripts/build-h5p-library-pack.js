#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 / R7-core — construye el "Cursia H5P Library Pack" (HD-V21-15):
// un .h5p autocontenido (runtime + editor) por librería principal de
// CURSIA_H5P_PROFILE_V1, más un manifest con versiones y hashes, más el README
// de instalación para el administrador del sitio Moodle.
//
// Salida de build: NO se versiona (ver .gitignore).
//
// Uso (después de `npm run build`):
//   node scripts/build-h5p-library-pack.js <libsDir> <outDir> [--profile v1|v2]
//
// EV6 H5P v2: `--profile v2` arma el pack de CURSIA_H5P_PROFILE_V2 (las 7 principales de v1 +
// Branching Scenario 1.10 + Dialog Cards 1.9; las carpetas nuevas salen del store versionado
// assets/h5p-libs/v2, las de v1 de <libsDir>). Mismo README (sección v2 incluida).

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const pi = args.indexOf('--profile');
const profileName = pi >= 0 ? args[pi + 1] : 'v1';
const [libsDir, outDir] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--profile');
if (!libsDir || !outDir || !['v1', 'v2'].includes(profileName)) {
  console.error('uso: node scripts/build-h5p-library-pack.js <libsDir> <outDir> [--profile v1|v2]');
  process.exit(2);
}

const { buildCursiaH5pLibraryPack } = require(path.resolve('dist/package/h5p/library-pack.js'));
const h5p = require(path.resolve('dist/package/h5p/index.js'));
const profile = profileName === 'v2' ? h5p.CURSIA_H5P_PROFILE_V2 : h5p.CURSIA_H5P_PROFILE_V1;

buildCursiaH5pLibraryPack({ libsDir: path.resolve(libsDir), outDir: path.resolve(outDir), profile })
  .then((manifest) => {
    fs.copyFileSync(path.resolve('src/package/h5p/README-library-pack.md'), path.join(path.resolve(outDir), 'README-library-pack.md'));
    for (const p of manifest.packages) {
      console.log(`✅ ${p.file}  ${(p.bytes / 1024).toFixed(0)} KB  ${p.libraries.length} librerías  sha256 ${p.sha256.slice(0, 16)}…`);
    }
    console.log(`✅ manifest: ${path.join(path.resolve(outDir), 'cursia-h5p-library-pack.manifest.json')} (${manifest.libraries.length} librerías)`);
  })
  .catch((err) => {
    console.error(`❌ ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
