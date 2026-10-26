#!/usr/bin/env node
/* eslint-disable no-console */
// r75 · Agente E — ningún secreto en logs ni en la auditoría (02 §C «Regla», 01 §1.6, §4.2; matriz (h)).
//
//   S1  llamada de log (this.logger.*, logger.*, Logger.*, console.*) cuyo argumento interpola o pasa una expresión con
//       nombre sensible: password, tempPassword, token (salvo «tokens» de conteo de LLM), secret, serviceRole/
//       SERVICE_ROLE_KEY, apikey/api_key, authorization, cookie, jwt.
//   S2  log de cuerpos completos: JSON.stringify(req.body | body | dto | payload | response | res | result) o el objeto
//       `req`/`request`/`headers` entero dentro de una llamada de log, en src/modules/{access,authz,budgets}/**.
//   S3  auditoría (auditLog/audit.*(record|log|write|append)) con claves sensibles en el objeto (password, tempPassword,
//       token, secret, apiKey) → la auditoría nunca guarda secretos.
//   S4  `tempPassword` fuera de los archivos permitidos (admin-users.*, supabase-admin.client.ts, DTO/tipos), y un
//       controller que devuelve tempPassword sin `Cache-Control: no-store`.
//   S5  supabase-admin.client.ts: no loguea el body del request/respuesta ni headers (apikey/Authorization).
//
// Alcance: todo src/ (un secreto en un log es un bug en cualquier archivo). Exenciones documentadas en
// scripts/check-r75-no-secret-logs.allowlist.json { "archivo:línea": "motivo" } (se revisan a mano).
// Uso: node scripts/check-r75-no-secret-logs.js [--root <repo>] [--self-test]
'use strict';
const fs = require('fs');
const path = require('path');

const SENS = String.raw`(?:temp_?password|password|passwd|secret|service_?role(?:_?key)?|api_?key|apikey|authorization|bearer|cookie|jwt|access_?token|refresh_?token|id_?token|\btoken\b|tokenValue|rawToken)`;
const SENS_RE = new RegExp(SENS, 'i');
// «token» en contextos de conteo de LLM / tokens de Moodle no es secreto.
const BENIGN = /(input_?tokens|output_?tokens|max_?tokens|tokens?_?(used|count|budget|in|out)|totalTokens|tokenCount|\$@[A-Z]+\*|moodle token|TOKEN\*|cache_?(read|creation)_?tokens|finops-token header|tokenEstimate)/i;
const LOG_CALL = /(?:\bthis\.logger|\blogger|\bLogger|\bconsole)\s*\.\s*(log|warn|error|debug|verbose|info|fatal)\s*\(/;

function extractCall(lines, i) {
  // devuelve el texto de la llamada desde la línea i hasta cerrar paréntesis (máx 12 líneas)
  let depth = 0, txt = '', started = false;
  for (let j = i; j < Math.min(lines.length, i + 12); j++) {
    const l = lines[j];
    for (let k = 0; k < l.length; k++) {
      const ch = l[k];
      if (!started) { const m = l.slice(k).match(LOG_CALL); if (m && m.index === 0) { started = true; } }
      if (ch === '(') depth++;
      if (ch === ')') { depth--; if (started && depth <= 0) { txt += l.slice(0, k + 1); return txt; } }
    }
    txt += l + '\n';
  }
  return txt;
}
// Parte «expresiones» del argumento: interpolaciones ${…} y argumentos fuera de comillas.
function exprParts(call) {
  const parts = [];
  const re = /\$\{([^}]*)\}/g; let m;
  while ((m = re.exec(call))) parts.push(m[1]);
  const noStr = call.replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
  const inner = noStr.replace(/^[\s\S]*?\(/, '').replace(/\)\s*;?\s*$/, '');
  parts.push(...inner.split(','));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function lintText(rel, text) {
  const out = [];
  const lines = text.split('\n');
  const r75 = /^src\/modules\/(access|authz|budgets)\//.test(rel);
  const isAdminClient = /supabase-admin\.client\.ts$/.test(rel);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(\/\/|\*)/.test(l)) continue;
    if (LOG_CALL.test(l)) {
      const call = extractCall(lines, i);
      for (const p of exprParts(call)) {
        if (SENS_RE.test(p) && !BENIGN.test(p) && !/^\s*""\s*$/.test(p) && !/^!!|^typeof\b/.test(p) && !/\b(length|size|Boolean|typeof|present|has[A-Z]\w*|configured|\.redact|redact\w*|mask\w*)\b/.test(p))
          out.push({ rule: 'S1', line: i + 1, msg: `log con expresión sensible «${p.slice(0, 60)}»` });
      }
      if ((r75 || isAdminClient) && /JSON\.stringify\(\s*(req\.body|request\.body|body|dto|payload|response|res|result|headers|req|request)\b/.test(call))
        out.push({ rule: 'S2', line: i + 1, msg: 'log de un cuerpo/headers completo' });
      if ((r75 || isAdminClient) && /,\s*(req|request|headers|body|dto|init|options)\s*\)/.test(call))
        out.push({ rule: 'S2', line: i + 1, msg: 'log de un objeto request/headers completo' });
    }
    if (/\baudit\w*\s*\.\s*(record|log|write|append|entry)\s*\(/i.test(l)) {
      const blk = lines.slice(i, i + 15).join('\n');
      const end = blk.indexOf(');');
      const call = end >= 0 ? blk.slice(0, end) : blk;
      const m = call.match(/\b(temp_?password|password|secret|api_?key|access_?token|refresh_?token|service_?role\w*)\s*[:,}]/i);
      if (m) out.push({ rule: 'S3', line: i + 1, msg: `auditoría con clave sensible «${m[1]}»` });
    }
  }
  // S4
  if (/tempPassword/.test(text)) {
    const allowed = /admin-users\.(controller|service)\.ts$|supabase-admin\.client\.ts$|\.dto\.ts$|types?\.ts$/.test(rel);
    if (!allowed) out.push({ rule: 'S4', line: lines.findIndex((x) => /tempPassword/.test(x)) + 1, msg: 'tempPassword fuera de admin-users/supabase-admin' });
    if (/\.controller\.ts$/.test(rel) && !/no-store/.test(text)) out.push({ rule: 'S4', line: lines.findIndex((x) => /tempPassword/.test(x)) + 1, msg: 'controller devuelve tempPassword sin Cache-Control: no-store' });
  }
  // S5
  if (isAdminClient) lines.forEach((l, i) => { if (LOG_CALL.test(l) && /(body|headers|apikey|Authorization|init)\b/.test(l) && !/status/.test(l)) out.push({ rule: 'S5', line: i + 1, msg: 'supabase-admin.client registra body/headers' }); });
  return out.map((x) => ({ file: rel, ...x, src: (lines[x.line - 1] || '').trim().slice(0, 160) }));
}

function selfTest() {
  const C = [
    ['src/x.ts', "this.logger.log(`creado ${email} con ${tempPassword}`);", 2],
    ['src/x.ts', "this.logger.warn('password reset falló', err.message);", 0],
    ['src/x.ts', "console.log('tokens', usage.input_tokens);", 0],
    ['src/x.ts', 'this.logger.error(`fallo: ${process.env.SUPABASE_SERVICE_ROLE_KEY}`);', 1],
    ['src/modules/access/a.ts', 'this.logger.debug(JSON.stringify(req.body));', 1],
    ['src/modules/access/a.ts', "await this.audit.record({ action: 'user.create', after: { email, tempPassword } });", 2],
    ['src/modules/access/a.ts', "await this.audit.record({ action: 'user.create', after: { email, mode } });", 0],
    ['src/modules/access/admin-users.controller.ts', 'return { tempPassword };', 1],
    ['src/modules/access/admin-users.controller.ts', "res.setHeader('Cache-Control','no-store'); return { tempPassword };", 0],
    ['src/modules/x/y.ts', 'const tempPassword = 1;', 1],
    ['src/x.ts', 'this.logger.log(`token presente: ${!!token}`);', 0],
  ];
  let bad = 0;
  for (const [f, src, n] of C) { const got = lintText(f, src).length; if (got !== n) { bad++; console.log(`self-test FAIL (${got}≠${n}): ${src}`, lintText(f, src)); } }
  console.log(bad ? `self-test: ${bad} FALLAS` : `self-test: ${C.length} casos OK`);
  return !bad;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  if (!selfTest()) process.exit(2);
  const root = path.resolve(opt('--root') || path.join(__dirname, '..'));
  const allowFile = path.join(root, 'scripts', 'check-r75-no-secret-logs.allowlist.json');
  const allow = fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, 'utf8')) : {};
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['node_modules', 'dist'].includes(e.name) ? [] : walk(path.join(d, e.name))) : /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [path.join(d, e.name)] : []));
  const files = walk('src');
  const found = [];
  for (const f of files) for (const v of lintText(f, fs.readFileSync(path.join(root, f), 'utf8'))) if (!allow[`${v.file}:${v.line}`]) found.push(v);
  console.log(`r75 no-secret-logs: ${files.length} archivos de src/`);
  for (const v of found) console.log(`  ${v.rule} ${v.file}:${v.line}  ${v.msg}\n        ${v.src}`);
  console.log(found.length ? `FAIL (${found.length})` : 'OK');
  process.exit(found.length ? 1 : 0);
}
module.exports = { lintText };
if (require.main === module) main();
