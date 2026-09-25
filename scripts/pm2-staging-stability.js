#!/usr/bin/env node

// Chequeo de estabilidad de los procesos PM2 de STAGING después de un deploy.
//
// Uso (deploy-staging.yml, paso [6c]) — nada se escribe a disco porque
// `pm2 jlist` incluye el entorno de cada proceso (secretos):
//   A=$(sudo pm2 jlist | node scripts/pm2-staging-stability.js snapshot)
//   sleep 45
//   sudo pm2 jlist | node scripts/pm2-staging-stability.js compare "$A"
//
// Solo lee de stdin y solo imprime nombre / estado / reinicios / uptime de
// los procesos cuyo nombre termina en "-staging" — nunca el entorno. Los
// procesos de producción del mismo VPS no se tocan ni se listan.
// `compare` sale con 1 si algún proceso staging no está `online` o se
// reinició durante la ventana (crash loop).

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function stagingProcesses(jlistText) {
  const list = JSON.parse(jlistText);
  return list
    .filter((p) => typeof p.name === 'string' && p.name.endsWith('-staging'))
    .map((p) => ({
      name: p.name,
      status: p.pm2_env && p.pm2_env.status,
      restarts: p.pm2_env && Number(p.pm2_env.restart_time),
      uptimeSec: p.pm2_env && p.pm2_env.pm_uptime ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 1000) : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const mode = process.argv[2];
  const current = stagingProcesses(await readStdin());

  if (mode === 'snapshot') {
    process.stdout.write(JSON.stringify(current.map(({ name, restarts }) => ({ name, restarts }))));
    return;
  }

  if (mode !== 'compare') {
    console.error('uso: pm2-staging-stability.js snapshot|compare <snapshot-json>');
    process.exit(2);
  }

  const before = new Map(JSON.parse(process.argv[3] || '[]').map((p) => [p.name, p.restarts]));
  let bad = false;
  for (const p of current) {
    const prev = before.has(p.name) ? before.get(p.name) : null;
    const restartedInWindow = prev !== null && p.restarts > prev;
    const ok = p.status === 'online' && !restartedInWindow;
    if (!ok) bad = true;
    console.log(
      `${ok ? '✓' : '❌'} ${p.name.padEnd(40)} status=${p.status} reinicios=${p.restarts}` +
        `${prev !== null ? ` (antes ${prev})` : ' (nuevo)'} uptime=${p.uptimeSec ?? '?'}s`,
    );
  }
  if (current.length === 0) {
    console.error('❌ No se encontró ningún proceso PM2 "-staging"');
    process.exit(1);
  }
  if (bad) {
    console.error('❌ Algún proceso de staging no quedó online o se reinició en la ventana de observación');
    process.exit(1);
  }
  console.log(`✅ ${current.length} procesos de staging online y estables`);
}

main().catch((err) => {
  console.error('❌ pm2-staging-stability:', err && err.message ? err.message : err);
  process.exit(1);
});
