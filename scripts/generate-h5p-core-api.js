#!/usr/bin/env node
/* eslint-disable */
// r60 (D1) — genera src/package/h5p/cursia-h5p-core-api.json: la versión de la API del núcleo H5P (`coreApi` de cada
// library.json) que exige CADA librería de los perfiles Cursia v1/v2/v3, con el patch exacto del perfil.
// Moodle rechaza al instalar una librería cuyo coreApi supera el del núcleo que trae (h5plib v124 = 4.1 … v128 = 4.5:
// «api-version-unsupported»). El builder y el validador usan esta tabla para declarar el Moodle mínimo real del paquete.
// Se genera (nunca a mano) y se versiona. Uso:
//   node scripts/generate-h5p-core-api.js [<libsDir>] [--check]
// Las carpetas se buscan en <libsDir> (opcional) y en lo que el repo YA versiona: los stores assets/h5p-libs/v3 y v2 y
// la fixture test/fixtures/h5p-profile-v1/libs (las 76 library.json de v1/v2/v3). Con --check no escribe: falla si el
// JSON versionado difiere de lo que dicen esas library.json.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const libsDir = args.find((a) => !a.startsWith('--'));

const OUT = path.join(ROOT, 'src/package/h5p/cursia-h5p-core-api.json');
const dirs = [...(libsDir ? [path.resolve(libsDir)] : []), path.join(ROOT, 'assets/h5p-libs/v3'), path.join(ROOT, 'assets/h5p-libs/v2'), path.join(ROOT, 'test/fixtures/h5p-profile-v1/libs')];

const libraries = {};
for (const v of ['v1', 'v2', 'v3']) {
  const prof = JSON.parse(fs.readFileSync(path.join(ROOT, `src/package/h5p/cursia-h5p-profile.${v}.json`), 'utf8'));
  for (const l of prof.libraries) {
    const key = `${l.machineName} ${l.majorVersion}.${l.minorVersion}`;
    const dirName = `${l.machineName}-${l.majorVersion}.${l.minorVersion}`;
    const d = dirs.map((x) => path.join(x, dirName)).find((x) => fs.existsSync(path.join(x, 'library.json')));
    if (!d) throw new Error(`H5P_CORE_API_LIBRARY_MISSING: ${dirName} (perfil ${v}) no está en ${dirs.join(', ')}`);
    const j = JSON.parse(fs.readFileSync(path.join(d, 'library.json'), 'utf8').replace(/^﻿/, ''));
    if (j.patchVersion !== l.patchVersion) throw new Error(`H5P_CORE_API_PATCH_MISMATCH: ${dirName} patch ${j.patchVersion} ≠ perfil ${v} ${l.patchVersion}`);
    const coreApi = j.coreApi ? `${j.coreApi.majorVersion}.${j.coreApi.minorVersion}` : null;
    const prev = libraries[key];
    if (prev && (prev.patch !== l.patchVersion || prev.coreApi !== coreApi)) throw new Error(`H5P_CORE_API_PROFILE_CONFLICT: ${key} con dos patches entre perfiles`);
    libraries[key] = { patch: l.patchVersion, coreApi };
  }
}
const sorted = Object.fromEntries(Object.keys(libraries).sort().map((k) => [k, libraries[k]]));
const json = JSON.stringify({ _comment: 'Generado por scripts/generate-h5p-core-api.js (no editar a mano). coreApi = library.json#coreApi del patch del perfil; null = sin requisito.', libraries: sorted }, null, 2) + '\n';
if (check) {
  const cur = fs.readFileSync(OUT, 'utf8');
  if (cur !== json) { console.error('❌ cursia-h5p-core-api.json desactualizado: regenerar con scripts/generate-h5p-core-api.js'); process.exit(1); }
  console.log(`✅ cursia-h5p-core-api.json al día (${Object.keys(sorted).length} librerías)`);
} else {
  fs.writeFileSync(OUT, json);
  console.log(`✅ ${OUT} (${Object.keys(sorted).length} librerías)`);
}
