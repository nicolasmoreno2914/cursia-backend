#!/usr/bin/env node
/* eslint-disable no-console */
// r75 · Agente E — lint de casts SQL por la deriva de tipos staging ↔ prod (H13, 01 §1 D-2, §1.9).
//
// Deriva real: production_jobs.owner_id uuid (prod) / varchar(36) (staging); production_jobs.course_id text (prod) /
// integer (staging); artifacts.owner_id uuid (prod). Las tablas nuevas r75 usan uuid (user_id, institution_id) y las
// columnas nuevas de courses varchar(36). Reglas (sobre el SQL embebido en .ts/.js/.sql):
//   C1  production_jobs.course_id / owner_id (por nombre de tabla o alias: `production_jobs pj` → pj.course_id) en una
//       comparación (=, <>, !=, IN, = ANY) SIN `::text` → prohibido.
//   C2  artifacts.owner_id (tabla o alias) en una comparación sin `::text` → prohibido.
//   C3  comparación columna-contra-columna entre una columna «legacy de dueño» (owner_id, *_by de courses, startedBy del
//       jsonb) y una columna uuid de las tablas nuevas (user_id, actor_id, created_by…) sin `::text` en AMBOS lados.
//   C4  `production_jobs.course_id = <entero literal>` (o alias) → prohibido aunque tenga cast del lado izquierdo
//       solo si el derecho no es texto: se exige `::text` / literal entre comillas.
//
// Alcance por defecto: SOLO lo que r75 agrega — archivos nuevos de src/modules/{access,authz,budgets}, migraciones y
// scripts r75, y las LÍNEAS AGREGADAS respecto de --base (default origin/staging) en el resto. `--all` audita todo el
// repo (informativo; el código legacy tiene sus propias mitigaciones).
//
// Uso: node scripts/check-r75-sql-casts.js [--root <repo>] [--base origin/staging] [--all] [--self-test]
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CMP = String.raw`(?:=\s*any\s*\(|<>|!=|(?<![=!<>:])=(?!=|>)|\bin\s*\()`;

function aliasesOf(text, table) {
  const out = new Set([table]);
  const re = new RegExp(String.raw`\b(?:public\.)?${table}\b\s+(?:as\s+)?([a-z_][a-z0-9_]*)`, 'gi');
  let m;
  const KW = new Set(['where', 'set', 'on', 'join', 'left', 'inner', 'group', 'order', 'limit', 'for', 'returning', 'using', 'values', 'select', 'and', 'or', 'union', 'cross', 'right', 'full', 'natural', 'as', 'with', 'do']);
  while ((m = re.exec(text))) if (!KW.has(m[1].toLowerCase())) out.add(m[1]);
  return out;
}

// Devuelve las violaciones de una línea dado el texto completo del archivo (para alias).
function lintLine(line, ctx) {
  const v = [];
  const l = line.replace(/--.*$/, '');
  const colRe = (aliases, cols) => new RegExp(String.raw`\b(${[...aliases].join('|')})\.(${cols.join('|')})\b(\s*::\s*\w+)?`, 'gi');
  const check = (aliases, cols, rule) => {
    const re = colRe(aliases, cols);
    let m;
    while ((m = re.exec(l))) {
      const after = l.slice(m.index + m[0].length);
      const before = l.slice(0, m.index);
      const inCmp = new RegExp('^\\s*' + CMP, 'i').test(after) || new RegExp(CMP + '\\s*\\(?\\s*$', 'i').test(before);
      if (!inCmp) continue;
      const cast = (m[3] || '').replace(/\s/g, '').toLowerCase();
      if (cast !== '::text') v.push({ rule, msg: `${m[1]}.${m[2]} comparado sin ::text` });
      // C4: el otro lado es un entero literal
      if (/production_jobs|pj/i.test(rule) || rule === 'C1') {
        const mm = after.match(new RegExp('^\\s*' + CMP + '\\s*(\\d+)\\b', 'i'));
        if (mm && m[2].toLowerCase() === 'course_id') v.push({ rule: 'C4', msg: `${m[1]}.course_id comparado con entero literal ${mm[1]} (usar '${mm[1]}' o ::text)` });
      }
    }
  };
  check(ctx.pj, ['course_id', 'owner_id'], 'C1');
  check(ctx.art, ['owner_id'], 'C2');
  // C3: owner/legacy ↔ columna uuid nueva
  const legacy = String.raw`(?:[a-z_]\w*\.)?(?:owner_id|created_by|updated_by|approved_by|generated_by)|\(?\s*[a-z_]\w*\.input_payload\s*->>\s*'startedBy'\s*\)?`;
  const nueva = String.raw`(?:[a-z_]\w*\.)(?:user_id|actor_id|lifted_by|decided_by|revoked_by)`;
  const pair = new RegExp(String.raw`(${legacy})(\s*::\s*\w+)?\s*(?:=|<>|!=)\s*(${nueva})(\s*::\s*\w+)?|(${nueva})(\s*::\s*\w+)?\s*(?:=|<>|!=)\s*(${legacy})(\s*::\s*\w+)?`, 'gi');
  let p;
  while ((p = pair.exec(l))) {
    const c1 = (p[2] || p[6] || '').replace(/\s/g, '').toLowerCase();
    const c2 = (p[4] || p[8] || '').replace(/\s/g, '').toLowerCase();
    if (c1 !== '::text' || c2 !== '::text') v.push({ rule: 'C3', msg: `comparación legacy↔uuid sin ::text en ambos lados: «${p[0].trim()}»` });
  }
  return v;
}

function lintText(text) {
  const ctx = { pj: aliasesOf(text, 'production_jobs'), art: aliasesOf(text, 'artifacts') };
  return text.split('\n').flatMap((line, i) => lintLine(line, ctx).map((x) => ({ ...x, line: i + 1, src: line.trim().slice(0, 160) })));
}

const R75_NEW = (f) => /^src\/modules\/(access|authz|budgets)\//.test(f) || /r75/.test(path.basename(f));
const LINTABLE = (f) => /\.(ts|js|sql)$/.test(f) && !/\.d\.ts$/.test(f) && !/^test\//.test(f) && !/check-r75-sql-casts\.js$/.test(f) && !/node_modules|\/dist\//.test(f);

function changedLines(root, base) {
  const out = {};
  let diff = '';
  try { diff = execFileSync('git', ['-C', root, 'diff', '-U0', `${base}...HEAD`, '--', 'src', 'scripts', '*.sql'], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch { return null; }
  // incluir también lo no commiteado (worktree en progreso)
  try { diff += execFileSync('git', ['-C', root, 'diff', '-U0', 'HEAD', '--', 'src', 'scripts', '*.sql'], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch {}
  let file = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(6); continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) { const s = +h[1], n = h[2] === undefined ? 1 : +h[2]; (out[file] = out[file] || new Set()); for (let k = s; k < s + n; k++) out[file].add(k); }
  }
  return out;
}
function untracked(root) {
  try { return execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', 'src', 'scripts', '.'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; }
}

function selfTest() {
  const cases = [
    ['select 1 from production_jobs pj where pj.course_id = $1', 1],
    ['select 1 from production_jobs pj where pj.course_id::text = $1::text', 0],
    ['update production_jobs set x=1 where production_jobs.owner_id = $2', 1],
    ['join production_jobs j on j.course_id::text = c.id::text', 0],
    ['from production_jobs pj where pj.course_id = 42', 2],
    ['from artifacts a where a.owner_id = $1', 1],
    ['from artifacts a where a.owner_id::text = $1', 0],
    ['join institution_memberships m on m.user_id = c.owner_id', 1],
    ['join institution_memberships m on m.user_id::text = c.owner_id::text', 0],
    ["where (pj.input_payload->>'startedBy') = r.user_id", 1],
    ['if (job.owner_id === user.id) return', 0],
    ['where c.owner_id = $1', 0],
  ];
  let bad = 0;
  for (const [sql, n] of cases) { const got = lintText(sql).length; if (got !== n) { bad++; console.log(`self-test FAIL (${got}≠${n}): ${sql}`, lintText(sql)); } }
  console.log(bad ? `self-test: ${bad} FALLAS` : `self-test: ${cases.length} casos OK`);
  return bad === 0;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  if (!selfTest()) process.exit(2);
  const root = path.resolve(opt('--root') || path.join(__dirname, '..'));
  const base = opt('--base') || 'origin/staging';
  const all = args.includes('--all');
  const found = [];
  const lintFile = (rel, onlyLines) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || !LINTABLE(rel)) return;
    for (const v of lintText(fs.readFileSync(abs, 'utf8'))) if (!onlyLines || onlyLines.has(v.line)) found.push({ file: rel, ...v });
  };
  let scope;
  if (all) {
    const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['node_modules', 'dist', '.git', 'test'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    scope = [...walk('src'), ...walk('scripts'), ...fs.readdirSync(root).filter((f) => f.endsWith('.sql'))];
    scope.forEach((f) => lintFile(f, null));
  } else {
    const ch = changedLines(root, base);
    if (ch === null) { console.log(`no se pudo calcular el diff contra ${base}`); process.exit(2); }
    const files = new Set([...Object.keys(ch), ...untracked(root)]);
    scope = [...files];
    for (const f of files) lintFile(f, R75_NEW(f) || !ch[f] ? null : ch[f]);
  }
  console.log(`r75 sql casts: ${scope.filter(LINTABLE).length} archivos revisados (${all ? 'todo el repo' : `cambios vs ${base} + archivos r75 completos`})`);
  for (const v of found) console.log(`  ${v.rule} ${v.file}:${v.line}  ${v.msg}\n        ${v.src}`);
  console.log(found.length ? `FAIL (${found.length})` : 'OK');
  process.exit(found.length ? 1 : 0);
}
module.exports = { lintText };
if (require.main === module) main();
