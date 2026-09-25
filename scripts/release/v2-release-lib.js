/* eslint-disable */
// Release curado de Cursia V2 (DN-7) — utilidades compartidas por
// check-v2-release.js y build-v2-release-manifest.js. Sin red, sin DB.
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const ALLOWLIST_PATH = path.join(__dirname, 'v2-release-allowlist.json');

function git(args, opts) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(opts || {}),
  });
}
function gitOk(args) {
  try { git(args); return true; } catch (e) { return false; }
}
function hasCommit(sha) {
  return gitOk(['cat-file', '-e', sha + '^{commit}']);
}
/** Blob id de `path` en `ref` o null si no existe. */
function blobAt(ref, p) {
  try { return git(['rev-parse', ref + ':' + p]).trim(); } catch (e) { return null; }
}
/** `git diff --name-status` base..head → [{status, path}] (renames desactivados). */
function diffNameStatus(base, head) {
  const out = git(['diff', '--no-renames', '--name-status', base, head]).trim();
  if (!out) return [];
  return out.split('\n').map((l) => {
    const [status, ...rest] = l.split('\t');
    return { status: status.trim(), path: rest.join('\t') };
  });
}
/** patch-id estable del diff base..head restringido a un path. */
function patchIdOf(base, head, p) {
  const diff = git(['diff', '--no-renames', base, head, '--', p]);
  if (!diff) return null;
  const out = execFileSync('git', ['patch-id', '--stable'], { cwd: REPO, input: diff, encoding: 'utf8' }).trim();
  return out ? out.split(/\s+/)[0] : null;
}
function showAt(ref, p) {
  try { return git(['show', ref + ':' + p]); } catch (e) { return null; }
}
/** Líneas agregadas/quitadas (sin el +/-; ignora vacías) de un diff unificado. */
function changedLines(diffText) {
  const added = []; const removed = [];
  for (const l of diffText.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+') && l.slice(1).trim()) added.push(l.slice(1));
    else if (l.startsWith('-') && l.slice(1).trim()) removed.push(l.slice(1));
  }
  return { added, removed };
}
function readAllowlist() { return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')); }
function isAncestor(a, b) { return gitOk(['merge-base', '--is-ancestor', a, b]); }

// ── Allow-list explícita + reconstrucción exacta de los PARTIAL ───────────
// La allow-list (v2-release-allowlist.json) la edita y revisa una persona:
// NINGÚN script la escribe. Un path nuevo o un hunk nuevo exigen editarla.
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
/** Id de blob de git de un texto (utf8). */
function gitBlobId(text) {
  const b = Buffer.from(text, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + b.length + '\0'), b])).digest('hex');
}
/** Divide un diff unificado de UN archivo en {header, hunks:[texto de cada hunk, desde su @@]}. */
function splitHunks(diffText) {
  const lines = diffText.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const header = []; const hunks = []; let cur = null;
  for (const l of lines) {
    if (l.startsWith('@@')) { cur = [l]; hunks.push(cur); continue; }
    if (cur) cur.push(l); else header.push(l);
  }
  return { header: header.join('\n'), hunks: hunks.map((h) => h.join('\n') + '\n') };
}
/** patch-id --stable de un único hunk (sobre un diff mínimo de `p`). */
function hunkPatchId(p, hunkText) {
  const d = `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${hunkText}`;
  const out = execFileSync('git', ['patch-id', '--stable'], { cwd: REPO, input: d, encoding: 'utf8' }).trim();
  return out ? out.split(/\s+/)[0] : null;
}
/**
 * Aplica ESTRICTAMENTE (sin fuzz, sin desplazamiento) los hunks a `baseText`
 * (null = archivo nuevo). Tira error si el contexto/las líneas quitadas no
 * coinciden byte a byte en la posición declarada.
 */
function applyHunksStrict(baseText, hunkTexts) {
  const src = baseText === null ? [] : (baseText.match(/[^\n]*\n|[^\n]+$/g) || []);
  const parsed = hunkTexts.map((h) => {
    const body = h.replace(/\n$/, '').split('\n');
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(body[0]);
    if (!m) throw new Error('cabecera de hunk inválida: ' + body[0]);
    const oldL = []; const newL = [];
    let last = null;
    for (const l of body.slice(1)) {
      if (l.startsWith('\\')) { if (last) last.arr[last.arr.length - 1] = last.arr[last.arr.length - 1].replace(/\n$/, ''); if (last && last.both) last.both[last.both.length - 1] = last.both[last.both.length - 1].replace(/\n$/, ''); continue; }
      const t = l.slice(1) + '\n'; const k = l[0];
      if (k === ' ') { oldL.push(t); newL.push(t); last = { arr: oldL, both: newL }; }
      else if (k === '-') { oldL.push(t); last = { arr: oldL }; }
      else if (k === '+') { newL.push(t); last = { arr: newL }; }
      else throw new Error('línea de hunk inválida: ' + l.slice(0, 80));
    }
    const oldStart = Number(m[1]); const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    if (oldL.length !== oldCount) throw new Error(`hunk ${body[0]}: ${oldL.length} líneas viejas ≠ ${oldCount}`);
    return { at: oldCount === 0 ? oldStart : oldStart - 1, oldL, newL, head: body[0] };
  });
  let out = src.slice(); let prevEnd = Infinity;
  for (const h of parsed.slice().sort((a, b) => b.at - a.at)) {
    if (h.at + h.oldL.length > prevEnd) throw new Error('hunks solapados: ' + h.head);
    const got = out.slice(h.at, h.at + h.oldL.length);
    if (got.length !== h.oldL.length || got.some((x, i) => x !== h.oldL[i])) throw new Error('el contexto no coincide con la base en ' + h.head);
    out.splice(h.at, h.oldL.length, ...h.newL); prevEnd = h.at;
  }
  return out.join('');
}
/** Cambios (+/-) de un hunk, sin vacíos. */
function hunkChanges(hunkText) { return changedLines(hunkText.split('\n').filter((l) => !l.startsWith('@@')).join('\n')); }
/** Conjuntos de líneas +/- de los commits dados (todo el commit: admite renames). */
function commitChangePools(commits) {
  const add = new Set(); const rem = new Set();
  for (const c of commits) {
    const cl = changedLines(git(['show', '--format=', '--no-renames', '--no-color', c]));
    cl.added.forEach((x) => add.add(x)); cl.removed.forEach((x) => rem.add(x));
  }
  return { add, rem };
}
/**
 * Verifica el bloque B contra la allow-list. Devuelve [{name, ok, detail}].
 * Reglas:
 *  - base y source fijados por SHA; si alguno no está disponible → FAIL.
 *  - todo path que difiere de la base está listado EXPLÍCITAMENTE (paths,
 *    partial o tooling); todo lo demás es byte-idéntico a la base.
 *  - paths: blob fijado; las categorías auditadas además == blob en source.
 *  - partial: base + los hunks listados (sha256 exacto + patch-id), aplicados
 *    estrictamente desde el .patch comprometido, == archivo del release; cada
 *    línea de cada hunk viene de sus commits `from` (ancestros de source),
 *    salvo hunks `adapter` (justificados y probados aparte).
 */
function verifyAllowlist(AL, { head = 'HEAD', selfPaths = [] } = {}) {
  const res = []; const add = (name, ok, detail) => res.push({ name, ok: !!ok, detail });
  const baseOk = hasCommit(AL.base.sha); const srcOk = hasCommit(AL.source.sha);
  add(`B base fijada ${AL.base.sha.slice(0, 7)} disponible (en CI: fetch-depth 0)`, baseOk, AL.base);
  add(`B source auditado fijado ${AL.source.sha.slice(0, 7)} disponible (en CI: fetch-depth 0; si la rama de integración se borró, restaurarla o fijar un tag)`, srcOk, AL.source);
  if (!baseOk) return res;
  add(`B base ${AL.base.sha.slice(0, 7)} es ancestro de HEAD`, isAncestor(AL.base.sha, head));
  const listed = new Map();
  for (const p of Object.keys(AL.paths)) listed.set(p, 'paths');
  for (const p of Object.keys(AL.partial)) { if (listed.has(p)) add(`B ${p} listado dos veces`, false); listed.set(p, 'partial'); }
  for (const p of AL.tooling) { if (listed.has(p)) add(`B ${p} listado dos veces`, false); listed.set(p, 'tooling'); }
  const diff = diffNameStatus(AL.base.sha, head);
  const notListed = diff.filter((d) => !listed.has(d.path)).map((d) => `${d.status} ${d.path}  (blob ${blobAt(head, d.path)})`);
  add(`B los ${diff.length} paths que difieren de la base están en la allow-list explícita (todo otro path == base ${AL.base.sha.slice(0, 7)})`, notListed.length === 0, notListed);
  const dp = new Set(diff.map((d) => d.path));
  const stale = [...listed.keys()].filter((p) => !dp.has(p) && !selfPaths.includes(p));
  add('B allow-list exacta (sin paths listados que no difieren de la base)', stale.length === 0, stale);
  const deleted = diff.filter((d) => d.status === 'D').map((d) => d.path);
  add('B el release no borra archivos de la base', deleted.length === 0, deleted);
  // paths con blob fijado
  const SRC = new Set(AL.sourceCategories);
  const bm = []; const sm = []; const badCat = [];
  for (const [p, e] of Object.entries(AL.paths)) {
    if (!AL.categories[e.category]) badCat.push(`${p}: ${e.category}`);
    const got = blobAt(head, p);
    if (got !== e.blob) bm.push(`${p} (HEAD ${got} ≠ fijado ${e.blob})`);
    if (SRC.has(e.category) && srcOk && blobAt(AL.source.sha, p) !== e.blob) sm.push(`${p} [${e.category}] (source ${blobAt(AL.source.sha, p)} ≠ fijado ${e.blob})`);
  }
  add('B categorías de la allow-list válidas', badCat.length === 0, badCat);
  add(`B los ${Object.keys(AL.paths).length} paths listados tienen el blob fijado en la allow-list`, bm.length === 0, bm);
  if (srcOk) add(`B los ${Object.values(AL.paths).filter((e) => SRC.has(e.category)).length} paths de categorías auditadas (${AL.sourceCategories.join('/')}) son byte-idénticos a source`, sm.length === 0, sm);
  // PARTIAL: reconstrucción exacta
  for (const [p, e] of Object.entries(AL.partial)) {
    const errs = [];
    if (!AL.tooling.includes(e.patch)) errs.push(`el .patch ${e.patch} no está listado en tooling`);
    const patchText = showAt(head, e.patch);
    if (patchText === null) { add(`B PARTIAL ${p}: reconstrucción exacta`, false, 'falta ' + e.patch); continue; }
    const { hunks } = splitHunks(patchText);
    const got = hunks.map((h) => ({ sha256: sha256(h), patchId: hunkPatchId(p, h) }));
    if (got.length !== e.hunks.length) errs.push(`${e.patch}: ${got.length} hunks ≠ ${e.hunks.length} listados`);
    got.forEach((g, i) => {
      const w = e.hunks[i];
      if (!w || w.sha256 !== g.sha256 || w.patchId !== g.patchId) errs.push({ hunk: i, listed: w ? { sha256: w.sha256, patchId: w.patchId } : null, patch: g, text: hunks[i].slice(0, 600) });
    });
    const baseText = showAt(AL.base.sha, p);
    let rebuilt = null;
    try { rebuilt = gitBlobId(applyHunksStrict(baseText, hunks)); } catch (x) { errs.push('aplicación estricta sobre la base falló: ' + x.message); }
    const headBlob = blobAt(head, p);
    if (rebuilt !== null && rebuilt !== headBlob) errs.push(`base + hunks listados = ${rebuilt} ≠ release ${headBlob}`);
    if (headBlob !== e.blob) errs.push(`blob del release ${headBlob} ≠ fijado ${e.blob}`);
    add(`B PARTIAL ${p}: base ${AL.base.sha.slice(0, 7)} + ${e.hunks.length} hunks listados (sha256 + patch-id) == archivo del release`, errs.length === 0, errs);
    const perr = [];
    e.hunks.forEach((w, i) => {
      if (!hunks[i]) return;
      if (w.adapter) { if (!String(w.adapter).trim()) perr.push(`hunk ${i}: adapter sin justificación`); return; }
      if (!w.from || !w.from.length) { perr.push(`hunk ${i}: sin commits de origen`); return; }
      const miss = w.from.filter((c) => !hasCommit(c));
      if (miss.length) { perr.push(`hunk ${i}: commits no disponibles ${miss.join(',')}`); return; }
      const notAud = srcOk ? w.from.filter((c) => !isAncestor(c, AL.source.sha)) : [];
      if (notAud.length) perr.push(`hunk ${i}: ${notAud.join(',')} no es ancestro del source auditado`);
      // adapterLines: líneas exactas propias del release (p. ej. un comentario
      // DN-7), exentas de procedencia solo con adapterReason explícito.
      if (w.adapterLines && !String(w.adapterReason || '').trim()) perr.push(`hunk ${i}: adapterLines sin adapterReason`);
      const allow = new Set(w.adapterLines || []);
      const pool = commitChangePools(w.from); const ch = hunkChanges(hunks[i]);
      const fa = ch.added.filter((x) => !pool.add.has(x) && !allow.has(x)); const fr = ch.removed.filter((x) => !pool.rem.has(x) && !allow.has(x));
      if (fa.length || fr.length) perr.push({ hunk: i, foreignAdded: fa.slice(0, 10), foreignRemoved: fr.slice(0, 10) });
    });
    add(`B PARTIAL ${p}: cada línea de cada hunk viene de sus commits V2 auditados (o es adapter justificado)`, perr.length === 0, perr);
  }
  for (const p of AL.mustEqualBase || []) add(`B ${p} idéntico a la base`, blobAt(head, p) === blobAt(AL.base.sha, p) && !listed.has(p));
  return res;
}

/** Líneas agregadas/quitadas (sin el +/-; ignora vacías) de un diff unificado. */
function changedLines(diffText) {
  const added = []; const removed = [];
  for (const l of diffText.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+') && l.slice(1).trim()) added.push(l.slice(1));
    else if (l.startsWith('-') && l.slice(1).trim()) removed.push(l.slice(1));
  }
  return { added, removed };
}
/**
 * Prueba "por hunks" de un archivo PARTIAL: cada línea que agrega/quita el
 * diff base..HEAD tiene que venir de alguno de los commits auditados
 * listados (en cualquier path, para admitir renames como 18fc918).
 */
function hunkProvenance(base, head, p, commits) {
  const own = changedLines(git(['diff', '--no-renames', base, head, '--', p]));
  const addPool = new Set(); const remPool = new Set();
  for (const c of commits) {
    const cl = changedLines(git(['show', '--format=', '--no-renames', c]));
    cl.added.forEach((x) => addPool.add(x)); cl.removed.forEach((x) => remPool.add(x));
  }
  return {
    foreignAdded: own.added.filter((x) => !addPool.has(x)),
    foreignRemoved: own.removed.filter((x) => !remPool.has(x)),
    added: own.added.length, removed: own.removed.length,
  };
}


// ── Anthropic / Opus ──────────────────────────────────────────────────────
// Patrón de "cliente Anthropic": SDK, endpoint HTTP directo, header de
// versión, ids de modelo Opus y la API key del servidor. El conjunto de
// (archivo, línea) que matchea en src/ tiene que ser IGUAL al de la base
// (origin/main): hoy solo brand-extraction (DN-6, ya en prod).
const ANTHROPIC_RE = '@anthropic-ai/sdk|api\\.anthropic\\.com|anthropic-version|claude-opus|ANTHROPIC_API_KEY';
/** Pares "archivo :: línea" (sin número de línea) que matchean en `ref`:src. */
function anthropicRefs(ref) {
  let out = '';
  try {
    out = git(['grep', '-n', '--no-color', '-E', ANTHROPIC_RE, ref, '--', 'src']).trim();
  } catch (e) {
    if (e.status === 1) return []; // git grep: 1 = sin matches
    throw e;
  }
  const prefix = ref + ':';
  return out.split('\n')
    .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l))
    .map((l) => { const m = /^([^:]+):\d+:(.*)$/.exec(l); return m ? m[1] + ' :: ' + m[2].trim() : l; })
    .sort();
}
function distAnthropicImporters(distRoot) {
  const found = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.js$/.test(e.name)) {
        if (fs.readFileSync(p, 'utf8').includes('@anthropic-ai/sdk')) found.push(path.relative(REPO, p));
      }
    }
  })(distRoot);
  return found.sort();
}

// ── Boot de la app Nest real (AppModule compilado) sin DB ─────────────────
// DataSource de TypeORM reemplazado por un proxy inerte (no abre sockets) y
// AdminSeedService (siembra en onModuleInit) por un stub. Todo lo demás es el
// grafo real de módulos/controllers de dist/, con el mismo prefijo global que
// main.ts. Devuelve { app, routes } con routes = ["METHOD /path", ...].
async function bootAppAndListRoutes(distRoot) {
  const R = (m) => require(path.join(REPO, 'node_modules', m));
  require(path.join(REPO, 'node_modules', 'reflect-metadata'));
  const { Test } = R('@nestjs/testing');
  const { Logger } = R('@nestjs/common');
  const { DataSource } = R('typeorm');
  const { getDataSourceToken } = R('@nestjs/typeorm');
  Logger.overrideLogger(false);
  const inert = () => new Proxy(function () {}, {
    get(t, k) {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => '';
      return inert();
    },
    apply() { return inert(); },
  });
  const fakeDs = new Proxy({}, {
    get(t, k) {
      if (k === 'then') return undefined;
      if (k === 'isInitialized') return true;
      if (k === 'destroy' || k === 'initialize') return async () => {};
      if (k === 'options') return { type: 'postgres' };
      return inert();
    },
  });
  const { AppModule } = require(path.join(distRoot, 'app.module.js'));
  const { AdminSeedService } = require(path.join(distRoot, 'admin/seed/admin-seed.service.js'));
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(getDataSourceToken()).useValue(fakeDs)
    .overrideProvider(DataSource).useValue(fakeDs)
    .overrideProvider(AdminSeedService).useValue({})
    .compile();
  const app = mod.createNestApplication({ logger: false, bodyParser: true });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  await app.init();
  const inst = app.getHttpAdapter().getInstance();
  const router = inst.router || inst._router;
  const routes = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) routes.push(m.toUpperCase() + ' ' + layer.route.path);
  }
  return { app, AppModule, routes: Array.from(new Set(routes)).sort() };
}

/** Recorre el grafo de módulos (imports estáticos y dinámicos) desde root. */
function walkModuleGraph(root) {
  const seen = new Set();
  const modules = [];
  const controllers = [];
  (function visit(m) {
    if (!m) return;
    const cls = typeof m === 'function' ? m : (m.module || null);
    if (!cls || seen.has(cls)) return;
    seen.add(cls);
    modules.push(cls.name);
    const imports = [].concat(Reflect.getMetadata('imports', cls) || [], (m && m.imports) || []);
    const ctrls = [].concat(Reflect.getMetadata('controllers', cls) || [], (m && m.controllers) || []);
    ctrls.forEach((c) => c && controllers.push(c.name));
    imports.forEach((i) => {
      if (i && typeof i.then === 'function') return; // forRootAsync ya resuelto por Nest
      if (i && i.forwardRef) return visit(i.forwardRef());
      visit(i);
    });
  })(root);
  return { modules, controllers };
}

module.exports = {
  REPO, ALLOWLIST_PATH, git, gitOk, hasCommit, blobAt, showAt, diffNameStatus, patchIdOf, readAllowlist, isAncestor,
  sha256, gitBlobId, splitHunks, hunkPatchId, applyHunksStrict, hunkChanges, commitChangePools, changedLines, verifyAllowlist,
  ANTHROPIC_RE, anthropicRefs, distAnthropicImporters, bootAppAndListRoutes, walkModuleGraph,
};
