#!/usr/bin/env node
/* eslint-disable */
// Release curado de Cursia V2 (DN-7) — genera scripts/release/v2-release-manifest.json
// a partir del árbol actual (HEAD). Solo para mantenedores del release: el
// manifest se revisa en el PR y check-v2-release.js lo hace cumplir.
//
// Clasificación de cada path que difiere de la base:
//   source   byte-idéntico a la rama de integración auditada (SOURCE)
//   partial  difiere de SOURCE a propósito (lista cerrada PARTIAL abajo); se
//            fija blob + patch-id del diff contra la base
//   tooling  herramientas del propio release (scripts/release, workflow de checks)
//   manifest este archivo
// Cualquier otro path hace FALLAR la generación (no se "acepta" nada nuevo).
//
// Uso: npm run build && node scripts/release/build-v2-release-manifest.js <baseSha> <sourceSha>

'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./v2-release-lib');

const PARTIAL = {
  'src/app.module.ts': 'V2 de 8a5cf49 sin las 2 líneas de CourseSetupModule (DN-7).',
  'scripts/check-dynamic-feature-gating.js': "V2 de 8a5cf49 sin 'CourseSetupController' en LEGACY_CONTROLLER_CLASS_NAMES (el controller no existe en el release).",
};
const TOOLING = [/^scripts\/release\//, /^\.github\/workflows\/v2-release-checks\.yml$/];
const MANIFEST_REL = path.relative(L.REPO, L.MANIFEST_PATH);

async function main() {
  const [base, source] = process.argv.slice(2);
  if (!base || !source) { console.error('uso: build-v2-release-manifest.js <baseSha> <sourceSha>'); process.exit(2); }
  const baseSha = L.git(['rev-parse', base]).trim();
  const sourceSha = L.git(['rev-parse', source]).trim();
  const files = {};
  const errors = [];
  for (const d of L.diffNameStatus(baseSha, 'HEAD')) {
    const p = d.path;
    if (p === MANIFEST_REL) { files[p] = { mode: 'manifest' }; continue; }
    const head = L.blobAt('HEAD', p);
    if (head === null) { errors.push('borrado respecto de la base (no previsto): ' + p); continue; }
    if (TOOLING.some((re) => re.test(p))) { files[p] = { mode: 'tooling', blob: head }; continue; }
    const src = L.blobAt(sourceSha, p);
    if (src === head) { files[p] = { mode: 'source', blob: head }; continue; }
    if (PARTIAL[p]) { files[p] = { mode: 'partial', blob: head, patchId: L.patchIdOf(baseSha, 'HEAD', p), reason: PARTIAL[p] }; continue; }
    errors.push('difiere de la base y de SOURCE sin estar en PARTIAL: ' + p);
  }
  for (const p of Object.keys(PARTIAL)) if (!files[p]) errors.push('PARTIAL declarado pero sin diff: ' + p);
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

  const { app, routes } = await L.bootAppAndListRoutes(path.join(L.REPO, 'dist'));
  await app.close();
  const distImp = L.distAnthropicImporters(path.join(L.REPO, 'dist'));

  const manifest = {
    schema: 1,
    release: 'cursia-v2 (DN-7, release curado)',
    repo: 'orbia-backend',
    base: { ref: 'origin/main', sha: baseSha },
    source: { ref: 'autonomous/cursia-v2-integration', sha: sourceSha },
    mustBeAbsent: ['src/modules/course-setup/'],
    mustEqualBase: ['.github/workflows/deploy.yml'],
    anthropicDistBaseline: distImp,
    expectedRoutes: routes,
    summary: Object.values(files).reduce((acc, e) => { acc[e.mode] = (acc[e.mode] || 0) + 1; return acc; }, {}),
    files: Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]])),
  };
  fs.writeFileSync(L.MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest: ${Object.keys(files).length} paths ${JSON.stringify(manifest.summary)}, ${routes.length} rutas`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
