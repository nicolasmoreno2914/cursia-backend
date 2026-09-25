#!/usr/bin/env node
/* eslint-disable */
// Release curado de Cursia V2 (DN-7) — check PERMANENTE de la rama
// release/cursia-v2. Local y en CI del PR de release (workflow
// v2-release-checks.yml); NO corre en deploy.yml. Sin red y sin DB.
//
// Requisitos: `npm ci && npm run build` (usa dist/) y la historia de git con
// el commit base del manifest (en CI: fetch-depth 0).
//
//  A  course-setup ausente (DN-7: "ni siquiera detrás de flag")
//     A1 src/modules/course-setup y dist/modules/course-setup no existen.
//     A2 "course-setup"/"CourseSetup" solo aparece en comentarios de src/ y dist/.
//     A3 el grafo de módulos de AppModule (dist) no tiene CourseSetupModule
//        ni ningún controller CourseSetup*.
//     A4 la app Nest real (AppModule compilado, DB inerte) arranca y su tabla
//        de rutas: sin /course-setup, IGUAL a expectedRoutes del manifest;
//        POST /api/v1/course-setup/extract-from-pdf por HTTP → 404.
//     A5 clientes Anthropic/Opus: el conjunto (archivo, línea) que matchea en
//        src/ es IGUAL al de la base (origin/main) y los importadores del SDK
//        en dist/ son exactamente anthropicDistBaseline (brand-extraction).
//  B  allow-list: todo path que difiere de la base está en el manifest y su
//     blob coincide con el fijado; los "source" coinciden además con la rama
//     de integración auditada (si ese commit está disponible); los "partial"
//     coinciden con su patch-id; mustEqualBase (deploy.yml) sin cambios;
//     mustBeAbsent sin archivos.
//
// Uso: node scripts/release/check-v2-release.js   (desde la raíz del repo)

'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const L = require('./v2-release-lib');

const HEAD = 'HEAD';
const DIST = path.join(L.REPO, 'dist');

let ok = 0;
let fail = 0;
function pass(name) { ok++; console.log('ok   ' + name); }
function bad(name, detail) {
  fail++;
  console.log('FAIL ' + name);
  if (detail !== undefined) console.log('     ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1)).slice(0, 4000));
}
function check(name, cond, detail) { cond ? pass(name) : bad(name, detail); }

function walkFiles(dir, re, acc) {
  acc = acc || [];
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, re, acc);
    else if (e.isFile() && re.test(e.name)) acc.push(p);
  }
  return acc;
}
/** Líneas con course-setup/CourseSetup que NO son comentario. */
function nonCommentCourseSetupRefs(dir, re) {
  const hits = [];
  for (const f of walkFiles(dir, re)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/course-setup|CourseSetup|course_setup/.test(line)) return;
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      hits.push(path.relative(L.REPO, f) + ':' + (i + 1) + ': ' + t.slice(0, 160));
    });
  }
  return hits;
}

function httpStatus(port, method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

async function main() {
  const M = L.readManifest();
  console.log(`== Cursia V2 release check (backend) — base ${M.base.sha.slice(0, 7)} (${M.base.ref}), source ${M.source.sha.slice(0, 7)} (${M.source.ref}), head ${L.git(['rev-parse', '--short', HEAD]).trim()}`);

  // ── A. course-setup ausente ───────────────────────────────────────────
  if (!fs.existsSync(path.join(DIST, 'app.module.js'))) {
    bad('dist/ compilado presente (correr `npm run build` antes)');
    return finish();
  }
  const absentPrefixes = M.mustBeAbsent || [];
  const headTree = L.git(['ls-tree', '-r', '--name-only', HEAD]).split('\n').filter(Boolean);
  for (const pre of absentPrefixes) {
    const present = headTree.filter((f) => f === pre || f.startsWith(pre.endsWith('/') ? pre : pre + '/'));
    check(`A1 ${pre} ausente en ${HEAD}`, present.length === 0, present);
  }
  check('A1 dist/modules/course-setup ausente', !fs.existsSync(path.join(DIST, 'modules', 'course-setup')));
  const srcRefs = nonCommentCourseSetupRefs(path.join(L.REPO, 'src'), /\.ts$/);
  check('A2 src/: course-setup/CourseSetup solo en comentarios', srcRefs.length === 0, srcRefs);
  const distRefs = nonCommentCourseSetupRefs(DIST, /\.js$/);
  check('A2 dist/: course-setup/CourseSetup solo en comentarios', distRefs.length === 0, distRefs);

  let booted = null;
  try {
    booted = await L.bootAppAndListRoutes(DIST);
    pass('A4 AppModule compilado arranca (DB inerte, sin red)');
  } catch (e) {
    bad('A4 AppModule compilado arranca (DB inerte, sin red)', e && e.stack);
  }
  if (booted) {
    const g = L.walkModuleGraph(booted.AppModule);
    const csMods = g.modules.filter((n) => /CourseSetup/i.test(n));
    const csCtrls = g.controllers.filter((n) => /CourseSetup/i.test(n));
    check(`A3 grafo de AppModule (${g.modules.length} módulos, ${g.controllers.length} controllers) sin CourseSetup*`, csMods.length + csCtrls.length === 0, { csMods, csCtrls });
    const top = (Reflect.getMetadata('imports', booted.AppModule) || []).map((m) => (m && (m.name || (m.module && m.module.name))) || '?');
    check('A3 AppModule.imports no contiene CourseSetupModule', !top.includes('CourseSetupModule'), top);

    const csRoutes = booted.routes.filter((r) => /course-setup|extract-from-pdf/i.test(r));
    check(`A4 tabla de rutas compilada (${booted.routes.length}) sin /course-setup`, csRoutes.length === 0, csRoutes);
    const expected = (M.expectedRoutes || []).slice().sort();
    const extra = booted.routes.filter((r) => !expected.includes(r));
    const missing = expected.filter((r) => !booted.routes.includes(r));
    check('A4 tabla de rutas == expectedRoutes del manifest', extra.length === 0 && missing.length === 0, { extra, missing });
    try {
      await booted.app.listen(0, '127.0.0.1');
      const port = booted.app.getHttpServer().address().port;
      const s1 = await httpStatus(port, 'POST', '/api/v1/course-setup/extract-from-pdf');
      const s2 = await httpStatus(port, 'GET', '/api/v1/course-setup');
      check('A4 HTTP POST /api/v1/course-setup/extract-from-pdf → 404', s1 === 404, s1);
      check('A4 HTTP GET /api/v1/course-setup → 404', s2 === 404, s2);
    } catch (e) {
      bad('A4 sondas HTTP', e && e.stack);
    }
    try { await booted.app.close(); } catch (e) {}
  }

  if (L.hasCommit(M.base.sha)) {
    const baseRefs = L.anthropicRefs(M.base.sha);
    const headRefs = L.anthropicRefs(HEAD);
    const added = headRefs.filter((r) => !baseRefs.includes(r));
    const removed = baseRefs.filter((r) => !headRefs.includes(r));
    check(`A5 referencias Anthropic/Opus en src/ == base (${headRefs.length})`, added.length === 0 && removed.length === 0, { added, removed });
  } else {
    bad('A5 commit base disponible para comparar Anthropic (en CI: fetch-depth 0)', M.base.sha);
  }
  const distImp = L.distAnthropicImporters(DIST);
  check('A5 importadores de @anthropic-ai/sdk en dist/ == anthropicDistBaseline', JSON.stringify(distImp) === JSON.stringify((M.anthropicDistBaseline || []).slice().sort()), distImp);

  // ── B. allow-list ────────────────────────────────────────────────────
  if (!L.hasCommit(M.base.sha)) {
    bad('B commit base disponible', M.base.sha);
    return finish();
  }
  check(`B base ${M.base.sha.slice(0, 7)} es ancestro de ${HEAD}`, L.gitOk(['merge-base', '--is-ancestor', M.base.sha, HEAD]));
  const diff = L.diffNameStatus(M.base.sha, HEAD);
  const files = M.files || {};
  const notAllowed = diff.filter((d) => !files[d.path]).map((d) => d.status + ' ' + d.path);
  check(`B los ${diff.length} paths que difieren de la base están en el manifest`, notAllowed.length === 0, notAllowed);
  const diffPaths = new Set(diff.map((d) => d.path));
  const stale = Object.keys(files).filter((p) => !diffPaths.has(p));
  check('B el manifest no lista paths que ya no difieren (manifest exacto)', stale.length === 0, stale);

  const srcAvail = L.hasCommit(M.source.sha);
  if (!srcAvail) console.log(`note commit source ${M.source.sha.slice(0, 7)} no disponible: se valida solo contra los blobs fijados en el manifest`);
  const blobMismatch = [];
  const sourceMismatch = [];
  const patchMismatch = [];
  for (const [p, e] of Object.entries(files)) {
    const got = L.blobAt(HEAD, p);
    if (e.mode === 'deleted') { if (got !== null) blobMismatch.push(p + ' (debería no existir)'); continue; }
    if (e.mode === 'manifest') continue; // el propio manifest no puede fijarse a sí mismo
    if (got !== e.blob) blobMismatch.push(p + ` (head ${got && got.slice(0, 10)} ≠ manifest ${e.blob && e.blob.slice(0, 10)})`);
    if (e.mode === 'source' && srcAvail) {
      const s = L.blobAt(M.source.sha, p);
      if (s !== e.blob) sourceMismatch.push(p + ` (source ${s && s.slice(0, 10)} ≠ manifest ${e.blob.slice(0, 10)})`);
    }
    if (e.mode === 'partial') {
      const pid = L.patchIdOf(M.base.sha, HEAD, p);
      if (pid !== e.patchId) patchMismatch.push(p + ` (patch-id ${pid} ≠ ${e.patchId})`);
    }
  }
  check('B cada path del manifest tiene el blob fijado', blobMismatch.length === 0, blobMismatch);
  const nSource = Object.values(files).filter((e) => e.mode === 'source').length;
  if (srcAvail) check(`B los ${nSource} paths "source" son byte-idénticos a la integración auditada`, sourceMismatch.length === 0, sourceMismatch);
  const nPartial = Object.values(files).filter((e) => e.mode === 'partial').length;
  check(`B los ${nPartial} paths PARTIAL coinciden con su patch-id`, patchMismatch.length === 0, patchMismatch);
  for (const p of M.mustEqualBase || []) {
    check(`B ${p} idéntico a la base`, L.blobAt(HEAD, p) === L.blobAt(M.base.sha, p));
  }
  return finish();
}

function finish() {
  console.log(`\n${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
