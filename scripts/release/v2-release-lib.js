/* eslint-disable */
// Release curado de Cursia V2 (DN-7) — utilidades compartidas por
// check-v2-release.js y build-v2-release-manifest.js. Sin red, sin DB.
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(__dirname, 'v2-release-manifest.json');

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
function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
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
  REPO, MANIFEST_PATH, git, gitOk, hasCommit, blobAt, diffNameStatus, patchIdOf, readManifest,
  ANTHROPIC_RE, anthropicRefs, distAnthropicImporters, bootAppAndListRoutes, walkModuleGraph,
};
