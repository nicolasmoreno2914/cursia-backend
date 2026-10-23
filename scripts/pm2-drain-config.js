#!/usr/bin/env node

// R16 (#1) — ¿el proceso PM2 de un worker dinámico ya está configurado para
// drenar? (deploy-staging.yml, ensure_pm2_drain_worker).
//
// Uso:
//   sudo pm2 jlist | node scripts/pm2-drain-config.js check <nombre> <script> <killTimeoutMs>
//
// Exit 0: corre `node <script>` directo (no un wrapper `npm run`) con
//   kill_timeout >= killTimeoutMs → basta `pm2 reload` (el drenado se respeta).
// Exit 1: proceso heredado (npm run o kill_timeout corto) → hay que recrearlo
//   (pm2 delete + pm2 start <script> --kill-timeout …). También si no existe.
// Exit 2: uso inválido / JSON ilegible.
//
// Solo lee stdin y solo imprime el nombre, el ejecutable y el kill_timeout —
// nunca el entorno del proceso (`pm2 jlist` lo incluye, con secretos).

const path = require('path');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Evaluación pura (exportada para el check). */
function drainConfigStatus(list, name, script, killTimeoutMs) {
  const proc = (Array.isArray(list) ? list : []).find((p) => p && p.name === name);
  if (!proc) return { ok: false, reason: 'no existe' };
  const env = proc.pm2_env || {};
  const execPath = String(env.pm_exec_path || '');
  const want = path.normalize(script).replace(/^\.\//, '');
  const direct = execPath === want || execPath.endsWith(`/${want}`);
  const kt = Number(env.kill_timeout);
  const longEnough = Number.isFinite(kt) && kt >= killTimeoutMs;
  if (!direct) return { ok: false, reason: `ejecutable ${path.basename(execPath) || '?'} ≠ ${want} (wrapper heredado)` };
  if (!longEnough) return { ok: false, reason: `kill_timeout ${Number.isFinite(kt) ? kt : '?'} ms < ${killTimeoutMs} ms` };
  return { ok: true, reason: `node ${want}, kill_timeout ${kt} ms` };
}

async function main() {
  const [cmd, name, script, ktRaw] = process.argv.slice(2);
  const kt = Number(ktRaw);
  if (cmd !== 'check' || !name || !script || !Number.isInteger(kt) || kt <= 0) {
    console.error('uso: pm2 jlist | node scripts/pm2-drain-config.js check <nombre> <script> <killTimeoutMs>');
    process.exit(2);
  }
  let list;
  try {
    list = JSON.parse(await readStdin());
  } catch (err) {
    console.error(`pm2-drain-config: pm2 jlist ilegible (${err instanceof Error ? err.message : String(err)})`);
    process.exit(2);
  }
  const r = drainConfigStatus(list, name, script, kt);
  console.log(`${name}: ${r.ok ? 'drenado configurado' : 'hay que recrearlo'} (${r.reason})`);
  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`pm2-drain-config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}

module.exports = { drainConfigStatus };
