#!/usr/bin/env node
/* eslint-disable */
// EV6 H5P v2 (H1) — sincroniza el store versionado de librerías H5P
// `assets/h5p-libs/v2/` (carpetas delta de CURSIA_H5P_PROFILE_V2 sobre v1) +
// `manifest.json` (sha256 por archivo, versión upstream, licencia, repo) +
// `LICENSES.md` (aviso MIT por librería).
//
// Fuente: una carpeta LOCAL de librerías H5P (`<libsDir>/<Machine-maj.min>/…`,
// p. ej. ~/cursia-test-env/h5p-libs). NO descarga nada (ruling de procedencia
// 2026-10-01: machineName/author/version del library.json + repo upstream
// github.com/h5p/<repo> + licencia MIT, verificado por el controlador).
//
// Uso:
//   node scripts/sync-h5p-library-store-v2.js <libsDir>          escribe el store
//   node scripts/sync-h5p-library-store-v2.js <libsDir> --check  solo compara (exit 1 si difiere)
//
// El perfil sale de `src/package/h5p/cursia-h5p-profile.v2.json` (generado con
// `scripts/generate-h5p-profile.js <libsDir> --profile v2`).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const STORE = path.join(ROOT, 'assets/h5p-libs/v2');
const PROFILE_JSON = path.join(ROOT, 'src/package/h5p/cursia-h5p-profile.v2.json');

// Fuente de la licencia de cada librería (fix round 1, I-2): la evidencia EXACTA que aplica.
const LICENCE_SOURCE = Object.freeze({
  libraryJson: 'library.json',
  localFile: 'local LICENCE/README file',
  upstream: 'upstream repository verified 2026-10-01',
});
const DEFAULT_HOLDER = 'Joubel AS (H5P Group AS)';

/**
 * Repos upstream que el controlador verificó EN LÍNEA el 2026-10-01 (licencia MIT).
 * Solo estos cuentan como evidencia de licencia cuando la librería no trae ni
 * `license` en library.json ni un archivo LICENCE/README con licencia.
 */
const UPSTREAM_VERIFIED_MIT = Object.freeze([
  'h5p-continuous-text',
  'h5p-exportable-text-area',
  'h5p-editor-branching-question',
  'h5p-editor-image-coordinate-selector',
  'h5p-editor-radio-selector',
  'h5p-editor-shape',
  'h5p-drag-question',
  'h5p-audio-recorder',
  'h5p-shape',
]);

/** Repositorio upstream oficial (organización h5p en GitHub) por machineName. */
const UPSTREAM_REPO = {
  'H5P.AudioRecorder': 'h5p-audio-recorder',
  'H5P.BranchingQuestion': 'h5p-branching-question',
  'H5P.BranchingScenario': 'h5p-branching-scenario',
  'H5P.ContinuousText': 'h5p-continuous-text',
  'H5P.CoursePresentation': 'h5p-course-presentation',
  'H5P.Dialogcards': 'h5p-dialogcards',
  'H5P.DragQuestion': 'h5p-drag-question',
  'H5P.ExportableTextArea': 'h5p-exportable-text-area',
  'H5P.ImageHotspots': 'h5p-image-hotspots',
  'H5P.InteractiveVideo': 'h5p-interactive-video',
  'H5P.Shape': 'h5p-shape',
  'H5P.TwitterUserFeed': 'h5p-twitter-user-feed',
  'H5PEditor.BranchingQuestion': 'h5p-editor-branching-question',
  'H5PEditor.BranchingScenario': 'h5p-editor-branching-scenario',
  'H5PEditor.CoursePresentation': 'h5p-editor-course-presentation',
  'H5PEditor.ImageCoordinateSelector': 'h5p-editor-image-coordinate-selector',
  'H5PEditor.InteractiveVideo': 'h5p-editor-interactive-video',
  'H5PEditor.RadioSelector': 'h5p-editor-radio-selector',
  'H5PEditor.Shape': 'h5p-editor-shape',
};

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function dirName(r) {
  return `${r.machineName}-${r.majorVersion}.${r.minorVersion}`;
}

function walk(root, rel = '') {
  const out = [];
  for (const n of fs.readdirSync(path.join(root, rel)).sort()) {
    const r = rel ? `${rel}/${n}` : n;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isSymbolicLink()) throw new Error(`H5P_STORE_SYMLINK: ${r}`);
    if (st.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Licencia declarada en un archivo local de la librería: LICENCE/LICENSE/COPYING
 * (siempre es una declaración) o README con sección de licencia. null = sin evidencia local.
 */
function localLicence(dir) {
  const names = fs.readdirSync(dir).sort();
  const pick = (re) => names.filter((n) => re.test(n));
  for (const f of [...pick(/^(licen[cs]e|copying)(\.[a-z]+)?$/i), ...pick(/^readme(\.[a-z]+)?$/i)]) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    const isReadme = /^readme/i.test(f);
    if (isReadme && !/licen[cs]e/i.test(t)) continue; // un README sin licencia no es evidencia
    const mit = /(The )?MIT License/.test(t) && /Permission is hereby granted, free of charge/.test(t);
    const m = /Copyright \(c\) ([^\n]+)/.exec(t);
    return { file: f, mit, holder: m ? m[1].trim() : null };
  }
  return null;
}

/** Licencia y su fuente exacta, o error (H5P_STORE_LICENCE_*) si no es MIT o no hay evidencia. */
function licenceOf(src, lj, repo, dirLabel) {
  const lic = localLicence(src);
  if (lj.license !== undefined && lj.license !== null && lj.license !== 'MIT') {
    throw new Error(`H5P_STORE_LICENCE_MISMATCH: ${dirLabel} library.json license=${JSON.stringify(lj.license)} (se exige MIT)`);
  }
  if (lic && !lic.mit) throw new Error(`H5P_STORE_LICENCE_MISMATCH: ${dirLabel} ${lic.file} no es MIT`);
  if (lj.license === 'MIT') return { licence: 'MIT', licenceSource: LICENCE_SOURCE.libraryJson, lic };
  if (lic) return { licence: 'MIT', licenceSource: LICENCE_SOURCE.localFile, lic };
  if (UPSTREAM_VERIFIED_MIT.includes(repo)) return { licence: 'MIT', licenceSource: LICENCE_SOURCE.upstream, lic };
  throw new Error(`H5P_STORE_LICENCE_MISSING: ${dirLabel} sin licencia en library.json, sin LICENCE/README y su repo ${repo} no está verificado`);
}

function buildStore(libsDir) {
  const profileText = fs.readFileSync(PROFILE_JSON, 'utf8');
  const profile = JSON.parse(profileText);
  if (profile.profileId !== 'CURSIA_H5P_PROFILE_V2' || !profile.deltaByMain) throw new Error('perfil v2 inválido');
  const delta = new Map();
  for (const refs of Object.values(profile.deltaByMain)) for (const r of refs) delta.set(dirName(r), r);
  const dirs = [...delta.keys()].sort();
  const files = new Map(); // ruta en el store → Buffer
  const libraries = [];
  const missing = [];
  for (const d of dirs) {
    const ref = delta.get(d);
    const src = path.join(libsDir, d);
    if (!fs.existsSync(path.join(src, 'library.json'))) {
      missing.push(d);
      continue;
    }
    const lj = JSON.parse(fs.readFileSync(path.join(src, 'library.json'), 'utf8'));
    if (lj.machineName !== ref.machineName || lj.majorVersion !== ref.majorVersion || lj.minorVersion !== ref.minorVersion || lj.patchVersion !== ref.patchVersion) {
      throw new Error(`H5P_STORE_VERSION_MISMATCH: ${d} library.json ${lj.majorVersion}.${lj.minorVersion}.${lj.patchVersion} ≠ perfil ${ref.patchVersion}`);
    }
    const repo = UPSTREAM_REPO[ref.machineName];
    if (!repo) throw new Error(`H5P_STORE_NO_PROVENANCE: ${ref.machineName} sin repo upstream registrado`);
    const { licence, licenceSource, lic } = licenceOf(src, lj, repo, d);
    const fileList = walk(src).map((rel) => {
      const buf = fs.readFileSync(path.join(src, rel));
      files.set(`${d}/${rel}`, buf);
      return { path: rel, bytes: buf.length, sha256: sha256(buf) };
    });
    libraries.push({
      dir: d,
      machineName: ref.machineName,
      majorVersion: ref.majorVersion,
      minorVersion: ref.minorVersion,
      patchVersion: ref.patchVersion,
      upstreamVersion: `${ref.majorVersion}.${ref.minorVersion}.${ref.patchVersion}`,
      author: lj.author ?? null,
      licence,
      licenceSource,
      repoUrl: `https://github.com/h5p/${repo}`,
      // true solo si el controlador verificó el repo en línea; los demás se derivan del nombre (h5p-<kebab>).
      repoUrlVerified: UPSTREAM_VERIFIED_MIT.includes(repo),
      libraryJsonLicense: lj.license ?? null,
      localLicenceFile: lic ? lic.file : null,
      copyrightHolder: lic && lic.holder ? lic.holder : DEFAULT_HOLDER,
      fileCount: fileList.length,
      totalBytes: fileList.reduce((a, f) => a + f.bytes, 0),
      files: fileList,
    });
  }
  if (missing.length) throw new Error(`H5P_PACKAGE_MISSING_LIBRARY_FILES: faltan en ${libsDir}: ${missing.join(', ')}`);
  const manifest = {
    storeVersion: 1,
    profileId: profile.profileId,
    baseProfileId: profile.baseProfileId,
    profileSha256: sha256(Buffer.from(profileText, 'utf8')),
    source: 'copia local de una carpeta de librerías H5P oficiales (sin descargas)',
    provenance:
      'machineName/author/version del library.json + repositorio upstream github.com/h5p/<repo> + licencia MIT; licenceSource dice qué evidencia aplica a cada librería (ruling del controlador 2026-10-01, fix round 1)',
    deltaByMain: Object.fromEntries(Object.entries(profile.deltaByMain).map(([k, v]) => [k, v.map(dirName)])),
    libraries,
  };
  const licenses = [
    '# Licencias de las librerías H5P del store v2',
    '',
    'Las carpetas de este directorio son copias sin modificar de librerías H5P oficiales',
    '(organización `h5p` en GitHub). Cursia las incluye dentro de los paquetes `.h5p` de',
    'Branching Scenario y Dialog Cards («delta» sobre CURSIA_H5P_PROFILE_V1). Versiones',
    'exactas y sha256 de cada archivo: `manifest.json`.',
    '',
    `Procedencia: ${manifest.provenance}.`,
    '',
    'Fuente de la licencia (columna «Evidencia»): `library.json` = campo `license` de la librería;',
    '`local LICENCE/README file` = archivo de licencia dentro de su carpeta; `upstream repository verified',
    '2026-10-01` = repositorio upstream verificado en línea por el controlador. Columna «Repo verificado»:',
    '«no» = URL deducido del nombre (h5p-<kebab>), sin verificación en línea.',
    '',
    'Los paquetes `.h5p` de Cursia redistribuyen estas carpetas tal como las publica H5P (sin agregar',
    'archivos): las que no traen su propio archivo de licencia viajan, como upstream, sin aviso dentro',
    'de la carpeta; este archivo y `manifest.json` son el aviso MIT de Cursia.',
    '',
    '| Librería | Versión | Copyright | Licencia | Evidencia | Repositorio | Repo verificado |',
    '|---|---|---|---|---|---|---|',
    ...libraries.map((l) => `| ${l.machineName} | ${l.upstreamVersion} | ${l.copyrightHolder} | ${l.licence} | ${l.licenceSource}${l.localLicenceFile ? ` (${l.localLicenceFile})` : ''} | ${l.repoUrl} | ${l.repoUrlVerified ? 'sí' : 'no'} |`),
    '',
    '## MIT License',
    '',
    'Copyright (c) the copyright holders listed above for each library (Joubel AS / H5P Group AS).',
    '',
    MIT_TEXT,
    '',
  ].join('\n');
  return { files, manifestText: JSON.stringify(manifest, null, 2) + '\n', licenses };
}

function main() {
  const args = process.argv.slice(2);
  const libsDir = args.find((a) => !a.startsWith('--'));
  if (!libsDir) {
    console.error('uso: node scripts/sync-h5p-library-store-v2.js <libsDir> [--check]');
    process.exit(2);
  }
  const { files, manifestText, licenses } = buildStore(path.resolve(libsDir));
  if (args.includes('--check')) {
    const diffs = [];
    const want = new Map([...files.entries()].map(([p, b]) => [p, sha256(b)]));
    want.set('manifest.json', sha256(Buffer.from(manifestText)));
    want.set('LICENSES.md', sha256(Buffer.from(licenses)));
    const have = fs.existsSync(STORE) ? walk(STORE) : [];
    for (const p of have) if (!want.has(p)) diffs.push(`sobra ${p}`);
    for (const [p, h] of want) {
      const fp = path.join(STORE, p);
      if (!fs.existsSync(fp)) diffs.push(`falta ${p}`);
      else if (sha256(fs.readFileSync(fp)) !== h) diffs.push(`difiere ${p}`);
    }
    if (diffs.length) {
      console.error(`❌ el store difiere (${diffs.length}): ${diffs.slice(0, 10).join('; ')}`);
      process.exit(1);
    }
    console.log(`✅ store v2 al día (${files.size} archivos de librería)`);
    return;
  }
  fs.rmSync(STORE, { recursive: true, force: true });
  for (const [p, b] of files) {
    fs.mkdirSync(path.dirname(path.join(STORE, p)), { recursive: true });
    fs.writeFileSync(path.join(STORE, p), b);
  }
  fs.writeFileSync(path.join(STORE, 'manifest.json'), manifestText);
  fs.writeFileSync(path.join(STORE, 'LICENSES.md'), licenses);
  console.log(`store v2 → ${STORE}: ${files.size} archivos de librería + manifest.json + LICENSES.md`);
}

module.exports = { licenceOf, localLicence, buildStore, LICENCE_SOURCE, UPSTREAM_VERIFIED_MIT, UPSTREAM_REPO };

if (require.main === module) main();
