#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 / R7-core — genera `src/package/h5p/cursia-h5p-profile.v1.json`
// (CURSIA_H5P_PROFILE_V1) a partir de una carpeta de librerías H5P
// (`<libsDir>/<Machine-maj.min>/library.json`).
//
// Usa el cálculo PURO compilado (`dist/package/h5p/profile-generator.js`), así
// que primero `npm run build`.
//
// Uso:
//   node scripts/generate-h5p-profile.js <libsDir> [--out <file>] [--sync-fixture]
//
// --sync-fixture  además copia `library.json` de cada librería del perfil y
//                 `semantics.json` de las librerías principales a
//                 `test/fixtures/h5p-profile-v1/libs/` (fixture committed que usa
//                 `scripts/check-v21-h5p.js` para no depender de la carpeta de
//                 librerías completa).

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const libsDir = args.find((a) => !a.startsWith('--'));
if (!libsDir) {
  console.error('uso: node scripts/generate-h5p-profile.js <libsDir> [--out <file>] [--sync-fixture]');
  process.exit(2);
}
const outIdx = args.indexOf('--out');
const outFile = path.resolve(outIdx >= 0 ? args[outIdx + 1] : 'src/package/h5p/cursia-h5p-profile.v1.json');
const syncFixture = args.includes('--sync-fixture');

const gen = require(path.resolve('dist/package/h5p/profile-generator.js'));

function readLibraryJsons(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name, 'library.json');
    if (fs.existsSync(p)) out[name] = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return out;
}

const libraryJsons = readLibraryJsons(path.resolve(libsDir));
const profile = gen.computeH5pProfile(libraryJsons);
fs.writeFileSync(outFile, gen.serializeH5pProfile(profile));
console.log(`perfil ${profile.profileId} v${profile.version}: ${profile.libraries.length} librerías → ${outFile}`);

if (syncFixture) {
  const fx = path.resolve('test/fixtures/h5p-profile-v1/libs');
  fs.rmSync(fx, { recursive: true, force: true });
  for (const lib of profile.libraries) {
    const dir = gen.h5pLibraryDirName(lib);
    fs.mkdirSync(path.join(fx, dir), { recursive: true });
    fs.copyFileSync(path.join(libsDir, dir, 'library.json'), path.join(fx, dir, 'library.json'));
  }
  for (const main of Object.values(profile.mainLibraries)) {
    const dir = gen.h5pLibraryDirName(main);
    fs.copyFileSync(path.join(libsDir, dir, 'semantics.json'), path.join(fx, dir, 'semantics.json'));
  }
  console.log(`fixture sincronizado → ${fx}`);
}
