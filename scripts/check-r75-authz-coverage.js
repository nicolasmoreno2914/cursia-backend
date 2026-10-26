#!/usr/bin/env node
/* eslint-disable no-console */
// r75 · Agente E — cobertura de autorización por handler (03 §1 «Agente E», 01 §3.3).
//
// Todo handler HTTP de un @Controller (método con @Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All) tiene que llevar,
// en el método o en la clase, UNA de estas marcas de src/modules/authz (agente B):
//   @RequirePermission(perm, scope)  ruta con permiso por institución/curso/run/artifact
//   @SuperAdminOnly()                ruta SA (además se exige SuperAdminGuard en @UseGuards del método o la clase)
//   @AuthenticatedOnly('motivo')     ruta JWT + cuenta que actúa solo sobre lo propio (motivo no vacío)
//   @AllowInactiveAccount()          /auth/me, /me/context, /features (responden aunque la cuenta esté suspendida)
//   @Public()                        pública a propósito (sin JWT): no puede llevar SupabaseJwtGuard
//   @PublicCapability()              URL de capacidad (p. ej. /media/* de r74): no puede llevar SupabaseJwtGuard
//   @TokenAuthenticated()            token de servicio (ingesta FinOps)
// …o figurar en la allow-list documentada scripts/check-r75-authz-coverage.allowlist.json ({ "METHOD /ruta": "motivo" }).
// Si falta alguna, el script falla (exit 1) y lista archivo:línea.
//
// Uso:  node scripts/check-r75-authz-coverage.js [--root <repo>] [--json <salida.json>] [--list]
//   --list   imprime la tabla completa de rutas (método, ruta, marca, archivo:línea)
// Exporta scanControllers(root) para la suite test/r75 (enumerar rutas JWT para la matriz (d)).
'use strict';
const fs = require('fs');
const path = require('path');

const HTTP = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];
const MARKS = ['RequirePermission', 'SuperAdminOnly', 'AuthenticatedOnly', 'AllowInactiveAccount', 'Public', 'PublicCapability', 'TokenAuthenticated'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, out); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// Lee un decorador completo (puede ocupar varias líneas) desde la línea i; devuelve { text, end }.
function readDecorator(lines, i) {
  let depth = 0, text = '', j = i;
  for (; j < lines.length; j++) {
    const l = lines[j].replace(/\/\/.*$/, '');
    text += (text ? ' ' : '') + l.trim();
    for (const ch of l) { if (ch === '(') depth++; else if (ch === ')') depth--; }
    if (depth <= 0) break;
  }
  return { text, end: j };
}
const decoName = (t) => (t.match(/^@([A-Za-z_][\w]*)/) || [])[1];
const decoArg = (t) => { const m = t.match(/^@\w+\(\s*(['"`])([^'"`]*)\1/); return m ? m[2] : (/^@\w+\(\s*\)/.test(t) || /^@\w+$/.test(t) ? '' : null); };
const joinPath = (a, b) => '/' + [a, b].filter((x) => x !== null && x !== undefined && x !== '').join('/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');

function scanFile(file, root) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/@Controller\(/.test(src)) return [];
  const lines = src.split('\n');
  const handlers = [];
  let pending = [];
  let cls = null; // { name, prefix, decos }
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    const tr = raw.trim();
    if (inBlockComment) { if (tr.includes('*/')) inBlockComment = false; continue; }
    if (tr.startsWith('/*')) { if (!tr.includes('*/')) inBlockComment = true; continue; }
    if (tr.startsWith('//') || tr.startsWith('*') || tr === '') continue;
    if (tr.startsWith('@')) {
      const d = readDecorator(lines, i);
      pending.push({ text: d.text, name: decoName(d.text), line: i + 1 });
      i = d.end;
      continue;
    }
    const mc = tr.match(/^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (mc) {
      const ctrl = pending.find((p) => p.name === 'Controller');
      cls = ctrl ? { name: mc[1], prefix: decoArg(ctrl.text) || '', decos: pending, line: i + 1 } : null;
      pending = [];
      continue;
    }
    if (cls && pending.length) {
      const http = pending.find((p) => HTTP.includes(p.name));
      const mm = tr.match(/^(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(/);
      if (http && mm) {
        const sub = decoArg(http.text);
        handlers.push({
          file: path.relative(root, file), line: http.line, controller: cls.name, handler: mm[1],
          method: http.name === 'All' ? 'ALL' : http.name.toUpperCase(), route: joinPath(cls.prefix, sub === null ? '<dinámica>' : sub),
          methodDecos: pending, classDecos: cls.decos,
        });
      }
    }
    pending = [];
  }
  return handlers;
}

function classify(h) {
  const all = [...h.methodDecos, ...h.classDecos];
  const has = (n) => all.some((d) => d.name === n);
  const text = (n) => all.filter((d) => d.name === n).map((d) => d.text).join(' ');
  const guards = all.filter((d) => d.name === 'UseGuards').map((d) => d.text).join(' ');
  const problems = [];
  const marks = MARKS.filter(has);
  if (has('SuperAdminOnly') && !/SuperAdminGuard/.test(guards)) problems.push('@SuperAdminOnly sin SuperAdminGuard en @UseGuards');
  if ((has('Public') || has('PublicCapability')) && /SupabaseJwtGuard/.test(guards)) problems.push('@Public/@PublicCapability con SupabaseJwtGuard (contradicción)');
  if (has('AuthenticatedOnly') && !/AuthenticatedOnly\(\s*(['"`])[^'"`]{3,}\1/.test(text('AuthenticatedOnly'))) problems.push('@AuthenticatedOnly sin motivo');
  if (/SuperAdminGuard/.test(guards) && marks.length === 0) problems.push('SuperAdminGuard sin @SuperAdminOnly');
  if (has('RequirePermission')) {
    const rp = h.methodDecos.filter((d) => d.name === 'RequirePermission').concat(h.classDecos.filter((d) => d.name === 'RequirePermission'));
    for (const d of rp) if (!/RequirePermission\(\s*['"`][a-z]+\.[a-z]+['"`]\s*,\s*\{/.test(d.text)) problems.push(`@RequirePermission mal formado: ${d.text.slice(0, 80)}`);
  }
  return { marks, problems };
}

function scanControllers(root) {
  const files = walk(path.join(root, 'src'));
  const hs = [];
  for (const f of files) hs.push(...scanFile(f, root));
  return hs.map((h) => ({ ...h, ...classify(h) }));
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const root = path.resolve(opt('--root') || path.join(__dirname, '..'));
  const allowFile = path.join(root, 'scripts', 'check-r75-authz-coverage.allowlist.json');
  const allow = fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, 'utf8')) : {};
  const hs = scanControllers(root);
  const uncovered = [], bad = [], allowed = [];
  const counts = {};
  for (const h of hs) {
    const key = `${h.method} ${h.route}`;
    for (const m of h.marks) counts[m] = (counts[m] || 0) + 1;
    if (h.problems.length) bad.push(h);
    if (h.marks.length === 0) {
      if (allow[key] && String(allow[key]).trim().length >= 3) { allowed.push(h); counts.allowlist = (counts.allowlist || 0) + 1; }
      else uncovered.push(h);
    }
  }
  const unusedAllow = Object.keys(allow).filter((k) => !k.startsWith('_') && !hs.some((h) => `${h.method} ${h.route}` === k));
  if (args.includes('--list')) for (const h of hs) console.log(`${h.method.padEnd(6)} ${h.route.padEnd(80)} ${(h.marks.join(',') || (allowed.includes(h) ? 'allow-list' : '—')).padEnd(22)} ${h.file}:${h.line}`);
  console.log(`r75 authz coverage: ${hs.length} handlers en ${new Set(hs.map((h) => h.file)).size} controllers`);
  console.log(`  marcas: ${JSON.stringify(counts)}`);
  const pct = hs.length ? (((hs.length - uncovered.length) / hs.length) * 100).toFixed(1) : '100.0';
  console.log(`  cubiertos: ${hs.length - uncovered.length}/${hs.length} (${pct} %)`);
  for (const h of uncovered) console.log(`  SIN MARCA  ${h.method} ${h.route}  (${h.controller}.${h.handler})  ${h.file}:${h.line}`);
  for (const h of bad) for (const p of h.problems) console.log(`  PROBLEMA   ${h.method} ${h.route}: ${p}  ${h.file}:${h.line}`);
  for (const k of unusedAllow) console.log(`  ALLOW-LIST HUÉRFANA  ${k} (ya no existe esa ruta)`);
  const out = opt('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ total: hs.length, uncovered: uncovered.map(({ methodDecos, classDecos, ...r }) => r), problems: bad.map(({ methodDecos, classDecos, ...r }) => r), counts, handlers: hs.map(({ methodDecos, classDecos, ...r }) => r) }, null, 2));
  const fail = uncovered.length + bad.length + unusedAllow.length;
  console.log(fail ? `FAIL (${uncovered.length} sin marca, ${bad.length} con problemas, ${unusedAllow.length} allow-list huérfanas)` : 'OK');
  process.exit(fail ? 1 : 0);
}

module.exports = { scanControllers };
if (require.main === module) main();
