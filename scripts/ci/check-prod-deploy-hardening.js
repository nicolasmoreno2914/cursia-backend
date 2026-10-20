#!/usr/bin/env node
/* eslint-disable */
// r61 — endurecimiento del deploy de PRODUCCIÓN (.github/workflows/deploy.yml + scripts/ops/prod-release.sh).
// USD 0, sin red, sin secretos: todo corre contra directorios temporales con pm2/npm/sudo FALSOS.
//
//   [WF] deploy.yml: triggers (push main + dispatch action deploy|rollback, force_deploy no|yes), jobs
//        exclusivos con environment production; PRIMER paso = guardia DEPLOY_FREEZE (bash ejecutado);
//        validación de variables V2 (bash ejecutado); paridad de checks con deploy-staging.yml (salvo los que
//        necesitan Moodle); gate REL R1 del frontend OBLIGATORIO; orden checks → SSH → preflight → runs
//        activos → esquema → ownership → snapshot → rsync → install → health → mark-ok; ningún `|| true` ni
//        continue-on-error en los pasos de producción; ningún ${{ }} dentro de un `run` que use ssh; rsync no
//        borra .release-*; el esquema V2 NO se migra desde deploy.yml; V1 intacto (cada proceso PM2 y cada
//        migración de origin/main sigue).
//   [SH] prod-release.sh ejecutado: install (flags V2 seguros, idempotente, secreto nunca impreso, compuerta
//        «V2 abierto a todos», DYNAMIC_WORKERS_HOLD, NODE_ENV), preflight por stdin, ciclo
//        snapshot → mark-ok → snapshot tras fallo → rollback (sin migraciones; .env/node_modules intactos),
//        rollback a una release pre-r61 sin workers dinámicos, ventana de estabilidad (crash loop → falla).
//
// Usage: node scripts/ci/check-prod-deploy-hardening.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WF = path.join(REPO, '.github/workflows/deploy.yml');
const STAGING_WF = path.join(REPO, '.github/workflows/deploy-staging.yml');
const SH = path.join(REPO, 'scripts/ops/prod-release.sh');
const yaml = require(path.join(REPO, 'node_modules/js-yaml'));

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }

// Checks de staging que producción NO corre en el runner (necesitan el Moodle local: gate completo).
const STAGING_ONLY_CHECKS = {
  'check-dynamic-package-worker-hardening': 'necesita Moodle local (NEEDS_MOODLE de scripts/ci/gate-core.sh)',
  'check-v21-packaging-v3': 'necesita Moodle local (NEEDS_MOODLE de scripts/ci/gate-core.sh)',
};
const PROD_NAMES = ['cursia-backend', 'cursia-content-worker', 'cursia-video-worker', 'cursia-audio-worker', 'cursia-h5p-worker',
  'cursia-gamma-worker', 'cursia-package-worker', 'cursia-full-worker', 'cursia-dynamic-item-worker',
  'cursia-dynamic-package-worker', 'cursia-dynamic-provider-worker'];
const SECRET = 'finops-secreto-de-prueba-NUNCA-impreso';
const OWNER = '11111111-2222-4333-8444-555555555555';

const wfText = fs.readFileSync(WF, 'utf8');
const wf = yaml.load(wfText);
const steps = (wf.jobs.deploy && wf.jobs.deploy.steps) || [];
const idx = (pred, m) => { const i = steps.findIndex(pred); assert(i >= 0, `paso no encontrado: ${m}`); return i; };
const runOf = (s) => (typeof s.run === 'string' ? s.run : '');

function bashStep(run, env) {
  const out = path.join(os.tmpdir(), `r61-gh-out-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(out, '');
  const r = spawnSync('bash', ['-e', '-c', run], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env }, encoding: 'utf8' });
  const outputs = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  fs.rmSync(out, { force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs };
}

// ════ [WF] ═════════════════════════════════════════════════════════════════
async function workflowChecks() {
  await check('[WF] YAML válido; push solo a main; dispatch con action (deploy|rollback, default deploy) y force_deploy (no|yes, default no)', () => {
    eq(wf.on.push.branches, ['main'], 'push');
    const inp = wf.on.workflow_dispatch.inputs;
    eq([inp.action.type, inp.action.options, inp.action.default], ['choice', ['deploy', 'rollback'], 'deploy'], 'action');
    eq([inp.force_deploy.type, inp.force_deploy.options, inp.force_deploy.default], ['choice', ['no', 'yes'], 'no'], 'force_deploy');
    eq(wf.concurrency, { group: 'deploy-production', 'cancel-in-progress': false }, 'concurrency');
    eq(wf.permissions, { contents: 'read' }, 'permisos mínimos');
  });

  await check('[WF] jobs deploy / rollback: environment production y condiciones EXCLUSIVAS (un push solo despliega)', () => {
    eq(Object.keys(wf.jobs).sort(), ['deploy', 'rollback'], 'jobs');
    eq([wf.jobs.deploy.environment, wf.jobs.rollback.environment], ['production', 'production'], 'environment');
    eq(wf.jobs.deploy.if, "github.event_name == 'push' || inputs.action == 'deploy' || inputs.action == ''", 'if deploy');
    eq(wf.jobs.rollback.if, "github.event_name == 'workflow_dispatch' && inputs.action == 'rollback'", 'if rollback');
  });

  await check('[WF] PRIMER paso = guardia DEPLOY_FREEZE (vars.DEPLOY_FREEZE; force solo por dispatch) — bash ejecutado con cada combinación', () => {
    const s = steps[0];
    assert(/DEPLOY_FREEZE/.test(s.name), `primer paso: ${s.name}`);
    eq(s.env.DEPLOY_FREEZE, '${{ vars.DEPLOY_FREEZE }}', 'variable');
    eq(s.env.FORCE_DEPLOY, "${{ github.event_name == 'workflow_dispatch' && inputs.force_deploy || 'no' }}", 'force solo por dispatch');
    for (const [env, want] of [[{ DEPLOY_FREEZE: 'true', FORCE_DEPLOY: 'no' }, 1], [{ DEPLOY_FREEZE: ' TRUE ', FORCE_DEPLOY: 'no' }, 1],
      [{ DEPLOY_FREEZE: 'true', FORCE_DEPLOY: 'yes' }, 0], [{ DEPLOY_FREEZE: '', FORCE_DEPLOY: 'no' }, 0], [{ DEPLOY_FREEZE: 'false', FORCE_DEPLOY: 'no' }, 0]]) {
      eq(bashStep(s.run, env).status, want, `DEPLOY_FREEZE=${JSON.stringify(env.DEPLOY_FREEZE)} force=${env.FORCE_DEPLOY}`);
    }
    // Idéntica a la de staging (misma semántica en los dos entornos).
    const st = yaml.load(fs.readFileSync(STAGING_WF, 'utf8')).jobs.deploy.steps[0];
    eq(s.run.replace(/a producción/g, 'a staging').replace(/ \(factory mode\)/, ''), st.run.replace(/ \(factory mode\)/, ''), 'mismo bash que staging');
  });

  await check('[WF] variables V2 validadas en el runner (bash ejecutado): UUID, booleanos, enteros, ref del frontend; default seguro = V2 apagado', () => {
    const s = steps[idx((x) => x.id === 'cfg', 'cfg')];
    let r = bashStep(s.run, {});
    assert(r.status === 1 && /Falta la variable PROD_FE_GATE_REF/.test(r.stdout), 'I2: sin PROD_FE_GATE_REF falla (nunca el main V1 del frontend por default)');
    r = bashStep(s.run, { FE_REF: 'staging' });
    eq([r.status, r.outputs.canary, r.outputs.workers, r.outputs.ga, r.outputs.block_v1, r.outputs.fe_ref, r.outputs.skip_storage], [0, '', 'false', 'false', 'false', 'staging', 'false'], 'solo el ref → V2 apagado');
    r = bashStep(s.run, { CANARY: ` ${OWNER.toUpperCase()} `, WORKERS: 'TRUE', POOL_MAX: '2', FE_REF: 'release/v2' });
    eq([r.status, r.outputs.canary, r.outputs.workers, r.outputs.pool_max, r.outputs.fe_ref], [0, OWNER, 'true', '2', 'release/v2'], 'canario normalizado');
    for (const bad of [{ CANARY: 'no-uuid' }, { CANARY: `${OWNER}'; rm -rf /` }, { WORKERS: 'yes' }, { GA: '1' }, { POOL_MAX: '2;id' }, { FE_REF: "main' x" }, { SKIP_STORAGE: 'si' }]) {
      eq(bashStep(s.run, { FE_REF: 'staging', ...bad }).status, 1, `rechaza ${JSON.stringify(bad)}`);
    }
    assert(/sin PROD_V2_CANARY_OWNER/.test(bashStep(s.run, { FE_REF: 'staging', WORKERS: 'true' }).stdout), 'aviso: workers sin canario quedan apagados');
    eq(bashStep(s.run, { FE_REF: 'staging', SKIP_STORAGE: 'TRUE' }).outputs.skip_storage, 'true', 'skip storage');
  });

  await check('[WF] paridad con deploy-staging.yml: todo check de staging corre en producción salvo los que necesitan Moodle (con motivo); + los de producción', () => {
    const grab = (t) => [...new Set([...t.matchAll(/node (scripts\/(?:ci\/)?check-[\w-]+\.js)/g)].map((m) => path.basename(m[1], '.js')))];
    const staging = grab(fs.readFileSync(STAGING_WF, 'utf8'));
    const prod = grab(wfText);
    const missing = staging.filter((c) => !prod.includes(c) && !STAGING_ONLY_CHECKS[c]);
    eq(missing, [], 'checks de staging ausentes en producción');
    for (const c of Object.keys(STAGING_ONLY_CHECKS)) {
      assert(!prod.includes(c), `${c} figura como excluido pero corre`);
      assert(fs.readFileSync(path.join(REPO, 'scripts/ci/gate-core.sh'), 'utf8').includes(c), `${c} no está en NEEDS_MOODLE de gate-core.sh`);
    }
    for (const c of ['check-prod-deploy-hardening', 'check-r60-prod-migrations-cover-staging', 'check-release-rollout-guard', 'check-deploy-freeze-guard', 'check-deploy-dynamic-workers']) {
      assert(prod.includes(c), `producción no corre ${c}`);
    }
    for (const c of prod) assert(fs.existsSync(path.join(REPO, 'scripts', `${c}.js`)) || fs.existsSync(path.join(REPO, 'scripts/ci', `${c}.js`)), `${c}.js no existe`);
  });

  await check('[WF] gate REL R1 del frontend OBLIGATORIO en producción: sin FRONTEND_REPO_READ_TOKEN falla (bash ejecutado); checkout sin persistir credenciales; --require-fe', () => {
    const iReq = idx((x) => /Require FRONTEND_REPO_READ_TOKEN/.test(x.name), 'require token');
    eq(steps[iReq].env.FRONTEND_REPO_READ_TOKEN, '${{ secrets.FRONTEND_REPO_READ_TOKEN }}', 'secret');
    eq(bashStep(steps[iReq].run, {}).status, 1, 'sin token → falla');
    eq(bashStep(steps[iReq].run, { FRONTEND_REPO_READ_TOKEN: 'x' }).status, 0, 'con token → sigue');
    const iCo = idx((x) => x.uses === 'actions/checkout@v4' && x.with && x.with.repository === 'nicolasmoreno2914/cursia', 'checkout FE');
    eq([steps[iCo].with['persist-credentials'], steps[iCo].with.ref, steps[iCo].if], [false, '${{ steps.cfg.outputs.fe_ref }}', undefined], 'checkout FE incondicional');
    const iGate = idx((x) => /check-rel-failure-classes\.js/.test(runOf(x)), 'gate');
    assert(/--require-fe --fe frontend-for-gate/.test(steps[iGate].run), 'gate con --require-fe');
    assert(iReq < iCo && iCo < iGate, 'orden');
  });

  await check('[WF] orden: build/checks → SSH → preflight → runs activos → esquema → ownership → snapshot → rsync → install → health → mark-ok', () => {
    const order = [
      ['build', (x) => runOf(x) === 'npm run build'],
      ['último check', (x) => /check-rel-failure-classes/.test(runOf(x))],
      ['ssh', (x) => x.name === 'Configure SSH'],
      ['preflight', (x) => /bash -s -- preflight/.test(runOf(x))],
      ['runs activos', (x) => /check-active-runs\.js/.test(runOf(x))],
      ['esquema', (x) => /< scripts\/prod\/v2-schema-probes\.js/.test(runOf(x))],
      ['ownership', (x) => /chown -R/.test(runOf(x))],
      ['snapshot', (x) => /bash -s -- snapshot/.test(runOf(x))],
      ['rsync', (x) => /\brsync -az --delete/.test(runOf(x))],
      ['install', (x) => /prod-release\.sh install/.test(runOf(x))],
      ['health', (x) => /HEALTH_URL/.test(runOf(x))],
      ['mark-ok', (x) => /mark-ok/.test(runOf(x))],
    ].map(([n, p]) => [n, idx(p, n)]);
    for (let i = 1; i < order.length; i++) assert(order[i - 1][1] < order[i][1], `${order[i - 1][0]} (${order[i - 1][1]}) debe ir antes de ${order[i][0]} (${order[i][1]})`);
    const iSsh = order[2][1];
    for (const s of steps.slice(iSsh)) {
      if (s.if === 'failure()') continue;
      assert(!s['continue-on-error'], `${s.name}: continue-on-error`);
      assert(!/\|\|\s*true/.test(runOf(s)), `${s.name}: || true`);
      if (/\bssh\b|\brsync\b/.test(runOf(s))) assert(!/\$\{\{/.test(runOf(s)), `${s.name}: expresión \${{ }} dentro del run (los valores van por env)`);
    }
  });

  await check('[WF] guardia de runs activos contra la base de PRODUCCIÓN: por stdin en VPS_PATH, --legacy (o --legacy-block), force solo por dispatch', () => {
    const s = steps[idx((x) => /check-active-runs\.js/.test(runOf(x)), 'guardia')];
    eq(s.env.DEPLOY_VPS_PATH, '${{ secrets.VPS_PATH }}', 'directorio de PRODUCCIÓN (su .env = base de producción)');
    assert(/cd '\$DEPLOY_VPS_PATH' && node - \$LEGACY_ARG \$FORCE_ARG" < scripts\/ops\/check-active-runs\.js/.test(s.run), s.run);
    eq(s.env.FORCE_DEPLOY, "${{ github.event_name == 'workflow_dispatch' && inputs.force_deploy || 'no' }}", 'force');
    assert(/LEGACY_ARG="--legacy-block"/.test(s.run) && /\[ "\$BLOCK_V1" = "true" \]/.test(s.run), 'opt-in de bloqueo por jobs V1');
  });

  await check('[WF] esquema V2: VERIFICA (sondas por stdin, seed v1 obligatorio, propuesta r60 informativa) y NUNCA migra V2 desde deploy.yml; force no lo saltea', () => {
    const s = steps[idx((x) => /< scripts\/prod\/v2-schema-probes\.js/.test(runOf(x)), 'esquema')];
    assert(/--pricing-keys-b64 '\$SEED_KEYS' --info-pricing-keys-b64 '\$PROPOSAL_KEYS' \$STORAGE_ARG" < scripts\/prod\/v2-schema-probes\.js/.test(s.run), s.run);
    assert(/STORAGE_ARG="--skip-storage-policies"/.test(s.run) && /::warning::PROD_SKIP_STORAGE_POLICY_PROBE=true/.test(s.run), 'M2: omitir las políticas de Storage solo con variable explícita y aviso');
    assert(!s.env.FORCE_DEPLOY && !/--force/.test(s.run), 'force_deploy no aplica');
    const all = wfText + fs.readFileSync(SH, 'utf8');
    assert(!/migrate-v2-production|MIGRATION_ENV=/.test(all), 'deploy.yml / prod-release.sh no corren el runner V2 ni migraciones V2');
    const migr = [...all.matchAll(/node scripts\/(migrate-[\w-]+\.js)/g)].map((m) => m[1]);
    eq([...new Set(migr)].sort(), ['migrate-production-jobs-constraints.js', 'migrate-usage-events-costs.js'], 'solo las 2 migraciones de siempre');
    // El paso que calcula las claves produce base64 de JSON válido con la forma esperada.
    const pk = steps[idx((x) => x.id === 'pricing', 'pricing')];
    const r = spawnSync('bash', ['-c', pk.run], { cwd: REPO, env: { PATH: process.env.PATH, GITHUB_OUTPUT: '/dev/stdout' }, encoding: 'utf8' });
    eq(r.status, 0, `pricing: ${r.stderr}`);
    const P = require(path.join(REPO, 'scripts/prod/v2-schema-probes.js'));
    const lines = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    eq(P.decodeKeys(lines.seed, 'seed').length, require(path.join(REPO, 'src/modules/finops/pricing-seed.v1.json')).rows.length, 'seed completo');
    assert(P.decodeKeys(lines.proposal, 'proposal').length > 0, 'propuesta r60');
  });

  await check('[WF] rsync: excluye .git, node_modules, .env, .env.*, .release-* (el snapshot de rollback no se borra) y el checkout del frontend', () => {
    const s = steps[idx((x) => /\brsync -az --delete/.test(runOf(x)), 'rsync')];
    for (const e of ['.git', 'node_modules', '.env', '.env.*', '.release-*', 'frontend-for-gate']) assert(s.run.includes(`--exclude '${e}'`), `falta --exclude '${e}'`);
    eq(s.env.DEPLOY_VPS_PATH, '${{ secrets.VPS_PATH }}', 'destino VPS_PATH');
  });

  await check('[WF] install: secreto FINOPS_INGEST_TOKEN_PRODUCTION SOLO por stdin (línea 1), claves de config = CFG_KEYS de prod-release.sh', () => {
    const s = steps[idx((x) => /prod-release\.sh install/.test(runOf(x)), 'install')];
    eq(s.env.FINOPS_INGEST_TOKEN_PRODUCTION, '${{ secrets.FINOPS_INGEST_TOKEN_PRODUCTION }}', 'secret de producción (≠ staging)');
    assert(/printf '%s\\n' "\$FINOPS_INGEST_TOKEN_PRODUCTION" \\/.test(s.run), 'línea 1 = secreto');
    const keys = [...s.run.matchAll(/"([A-Z0-9_]+)=\$/g)].map((m) => m[1]);
    const shKeys = /CFG_KEYS="([^"]+)"/.exec(fs.readFileSync(SH, 'utf8'))[1].split(' ');
    eq(keys.sort(), shKeys.sort(), 'claves');
    assert(!/STAGING/.test(JSON.stringify(wf.jobs)), 'ningún secret/valor de staging en el workflow de producción');
  });

  await check('[WF] rollback: scripts de ESTE commit por stdin, runs activos solo informan, sin migraciones, health check y mark-ok restored', () => {
    const rs = wf.jobs.rollback.steps;
    const r = rs.map(runOf).join('\n');
    assert(/node - --legacy --force" < scripts\/ops\/check-active-runs\.js/.test(r), 'runs activos informativos');
    assert(/bash -s -- rollback '\$DEPLOY_VPS_PATH'" < scripts\/ops\/prod-release\.sh/.test(r), 'rollback por stdin');
    assert(/bash -s -- mark-ok '\$DEPLOY_VPS_PATH' restored" < scripts\/ops\/prod-release\.sh/.test(r), 'mark-ok restored');
    assert(/HEALTH_URL/.test(r) && !/migrate-|npm run build|rsync -az/.test(r), 'sin migraciones / build / rsync desde el runner');
    assert(!JSON.stringify(rs).includes('DEPLOY_FREEZE'), 'el rollback no lo bloquea DEPLOY_FREEZE');
  });

  // r61 fix M4: la base de V1 es FIJA (deploy.yml de main 713a3f2, pre-V2): comparar contra origin/main pasaría en
  // vacío después del merge de la promoción (el deploy.yml nuevo ya no tiene líneas ensure_pm2_process inline).
  await check('[WF] I2: el gate REL R1 exige un frontend con el ejecutor dinámico (el main V1 del frontend no lo tiene) — bash ejecutado', () => {
    const s = steps[idx((x) => /ejecutor dinámico/.test(x.name || ''), 'frontend con ejecutor')];
    const iCo = idx((x) => x.uses === 'actions/checkout@v4' && x.with && x.with.repository === 'nicolasmoreno2914/cursia', 'checkout FE');
    const iGate = idx((x) => /check-rel-failure-classes\.js/.test(runOf(x)), 'gate');
    const me = steps.indexOf(s);
    assert(iCo < me && me < iGate, 'entre el checkout y el gate');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r61-fe-'));
    try {
      let r = spawnSync('bash', ['-e', '-c', s.run], { cwd: tmp, env: { PATH: process.env.PATH, FE_REF: 'main' }, encoding: 'utf8' });
      assert(r.status === 1 && /no tiene src\/js\/45-dynamic-generation-executor\.js/.test(r.stdout), r.stdout);
      fs.mkdirSync(path.join(tmp, 'frontend-for-gate/src/js'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'frontend-for-gate/src/js/45-dynamic-generation-executor.js'), '//');
      r = spawnSync('bash', ['-e', '-c', s.run], { cwd: tmp, env: { PATH: process.env.PATH, FE_REF: 'staging' }, encoding: 'utf8' });
      eq(r.status, 0, 'con ejecutor');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await check('[WF] I1: auto-rollback SOLO tras un fallo posterior al rsync (desactivable), restaura .release-prev por stdin, health + mark-ok restored; Notify sin la promesa falsa de «vaciar el canario apaga V2» (M3)', () => {
    const iSync = idx((x) => x.id === 'sync', 'rsync con id sync');
    const iAr = idx((x) => /Auto-rollback/.test(x.name || ''), 'auto-rollback');
    const ar = steps[iAr];
    eq(ar.if, "failure() && steps.sync.outcome == 'success' && vars.PROD_AUTO_ROLLBACK != 'false'", 'condición');
    assert(iAr > iSync && iAr > idx((x) => /mark-ok/.test(runOf(x)), 'mark-ok'), 'después del rsync y del mark-ok');
    assert(/bash -s -- rollback '\$DEPLOY_VPS_PATH'" < scripts\/ops\/prod-release\.sh/.test(ar.run) && /mark-ok '\$DEPLOY_VPS_PATH' restored/.test(ar.run) && /HEALTH_URL/.test(ar.run), ar.run);
    const notify = steps.find((x) => x.name === 'Notify on failure');
    assert(!/Apagar solo V2 sin tocar código: vaciar PROD_V2_CANARY_OWNER/.test(notify.run) && /V2 sigue encendido para el allowlist/.test(notify.run), 'M3');
  });

  await check('[WF] M5: el job rollback normaliza el dueño de VPS_PATH ANTES de restaurar', () => {
    const rs = wf.jobs.rollback.steps;
    const iC = rs.findIndex((x) => /chown -R/.test(runOf(x)));
    const iR = rs.findIndex((x) => /bash -s -- rollback/.test(runOf(x)));
    assert(iC >= 0 && iC < iR, `chown ${iC} restore ${iR}`);
  });

  await check('[WF] V1 intacto: cada proceso PM2 y cada migración del deploy.yml V1 (main 713a3f2, lista fija) sigue en prod-release.sh (mismo npm script)', () => {
    const FIXED_V1 = ['sudo pm2 reload cursia-backend --update-env', ...PROD_NAMES.slice(1, 8).map((n) => `ensure_pm2_process ${n} start:${n.replace(/^cursia-/, '').replace(/^full-worker$/, 'full-worker')}`),
      'node scripts/migrate-production-jobs-constraints.js', 'node scripts/migrate-usage-events-costs.js'].join('\n');
    let base = FIXED_V1;
    try {
      const pinned = execFileSync('git', ['show', '713a3f2:.github/workflows/deploy.yml'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const pick = (t) => [...t.matchAll(/ensure_pm2_process (cursia-[\w-]+) (start:[\w-]+)|node (scripts\/migrate-[\w-]+\.js)/g)].map((m) => m[0]).sort();
      eq(pick(pinned), pick(FIXED_V1), 'la lista fija coincide con el deploy.yml de 713a3f2');
      base = pinned;
    } catch (e) {
      if (/la lista fija/.test(e.message)) throw e;
      console.log('   (713a3f2 no disponible en este checkout: se usa la lista fija de V1)');
    }
    assert((base.match(/ensure_pm2_process cursia-/g) || []).length === 7 && (base.match(/node scripts\/migrate-/g) || []).length === 2, 'base V1 no vacía (7 workers + 2 migraciones)');
    const sh = fs.readFileSync(SH, 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    for (const m of base.matchAll(/ensure_pm2_process (cursia-[\w-]+) (start:[\w-]+)/g)) {
      const [, name, script] = m;
      if (sh.includes(`"${name} ${script}"`)) continue;
      const drain = new RegExp(`"${name} (dist/workers/[\\w-]+\\.js)"`).exec(sh);
      assert(drain && pkg.scripts[script] === `node ${drain[1]}`, `${name} (${script}) ya no se arranca igual`);
    }
    assert(/reload cursia-backend --update-env \|\| \$PM2 restart cursia-backend --update-env/.test(sh), 'backend: reload zero-downtime como antes');
    for (const m of base.matchAll(/node (scripts\/migrate-[\w-]+\.js)/g)) assert(sh.includes(`node ${m[1]}`), `migración de V1 ausente: ${m[1]}`);
    for (const n of PROD_NAMES) assert(sh.includes(n), `prod-release.sh no conoce ${n}`);
    assert(!/-staging\b/.test(sh.replace(/deploy-staging\.yml/g, '')), 'prod-release.sh no toca procesos de staging');
  });
}

// ════ [CI] gate-core en PRs de promoción ═════════════════════════════════════
async function gateCoreChecks() {
  await check('[CI] gate-core.yml corre en PRs a staging, main y release/**; sin CURSIA_FE_READ_TOKEN: main/release → falla de entrada, staging → sigue (BLOCKED = exit 3 al final, también rojo)', () => {
    const g = yaml.load(fs.readFileSync(path.join(REPO, '.github/workflows/gate-core.yml'), 'utf8'));
    eq(g.on.pull_request.branches, ['staging', 'main', 'release/**'], 'branches');
    const st = g.jobs['gate-core'].steps.find((x) => /Frontend/.test(x.name || ''));
    eq(st.env.FE_TOKEN, '${{ secrets.CURSIA_FE_READ_TOKEN }}', 'secret');
    for (const [base, want] of [['main', 1], ['release/v2', 1], ['staging', 0], ['', 0]]) {
      const r = spawnSync('bash', ['-e', '-c', st.run], { env: { PATH: process.env.PATH, BASE_REF: base, GITHUB_ENV: '/dev/null' }, encoding: 'utf8' });
      eq(r.status, want, `base=${base || '(dispatch)'}`);
    }
    const sh = fs.readFileSync(path.join(REPO, 'scripts/ci/gate-core.sh'), 'utf8');
    assert(/\[ \$BLOCKED_FE -ne 0 \] && exit 3/.test(sh), 'BLOCKED sale con 3 (nunca verde)');
    assert(sh.includes('scripts/ci/check-prod-deploy-hardening.js'), 'gate-core corre este check');
  });
}

// ════ [SH] prod-release.sh ejecutado con pm2/npm/sudo falsos ═════════════════
function mkFakeVps() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r61-prod-vps-'));
  const bin = path.join(root, 'bin');
  const app = path.join(root, 'app');
  fs.mkdirSync(bin);
  fs.mkdirSync(app);
  const log = path.join(root, 'calls.log');
  const jlist = path.join(root, 'jlist.json');
  const w = (p, c, mode) => fs.writeFileSync(p, c, mode ? { mode } : undefined);
  w(path.join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n', 0o755);
  w(path.join(bin, 'npm'), '#!/bin/sh\necho "npm $*" >> "$CALLS"\n', 0o755);
  w(path.join(bin, 'pdftoppm'), '#!/bin/sh\nexit 0\n', 0o755);
  w(path.join(bin, 'apt-get'), '#!/bin/sh\necho "apt-get $*" >> "$CALLS"\n', 0o755);
  // pm2 falso: describe según PM2_EXISTS (lista), jlist desde el archivo (BUMP_ON_SLEEP simula crash loop).
  w(path.join(bin, 'pm2'), '#!/bin/sh\necho "pm2 $*" >> "$CALLS"\ncase "$1" in\n  describe) case " $PM2_EXISTS " in *" $2 "*) exit 0 ;; *) exit 1 ;; esac ;;\n  jlist) cat "$PM2_JLIST" ;;\nesac\nexit 0\n', 0o755);
  // sleep falso: con BUMP_ON_SLEEP, a partir de la llamada nº BUMP_FROM (default 1) suma un reinicio a BUMP_NAME
  // (default: el primer proceso del jlist = cursia-backend) → simula un crash loop antes / después del deploy.
  w(path.join(bin, 'sleep'), '#!/bin/sh\n[ -n "$BUMP_ON_SLEEP" ] && node -e \'const fs=require("fs");const f=process.argv[1];const c=f+".sleeps";const n=(fs.existsSync(c)?Number(fs.readFileSync(c,"utf8")):0)+1;fs.writeFileSync(c,String(n));if(n<Number(process.env.BUMP_FROM||1))process.exit(0);const l=JSON.parse(fs.readFileSync(f));const p=process.env.BUMP_NAME?l.find((x)=>x.name===process.env.BUMP_NAME):l[0];p.pm2_env.restart_time++;fs.writeFileSync(f,JSON.stringify(l))\' "$PM2_JLIST"\nexit 0\n', 0o755);
  const jl = PROD_NAMES.map((n) => ({
    name: n,
    pm2_env: { status: 'online', restart_time: 0, env: { SECRET_IN_ENV: 'nunca-impreso' },
      pm_exec_path: n.startsWith('cursia-dynamic-') ? `${app}/dist/workers/${n.replace(/^cursia-/, '')}.js` : '/usr/bin/npm',
      kill_timeout: n.startsWith('cursia-dynamic-') ? 300000 : 1600 },
  }));
  jl.push({ name: 'cursia-backend-staging', pm2_env: { status: 'errored', restart_time: 99 } }, { name: 'videogen-api', pm2_env: { status: 'stopped', restart_time: 3 } });
  w(jlist, JSON.stringify(jl));
  return { root, bin, app, log, jlist };
}
function writeRelease(app, tag, { drainHelper = true, dynamicWorkers = true } = {}) {
  for (const d of ['dist/workers', 'scripts/prod', 'scripts/ops']) fs.mkdirSync(path.join(app, d), { recursive: true });
  fs.writeFileSync(path.join(app, 'dist/main.js'), `// release ${tag}\n`);
  for (const n of ['dynamic-item-worker', 'dynamic-package-worker', 'dynamic-provider-worker']) {
    const p = path.join(app, `dist/workers/${n}.js`);
    if (dynamicWorkers) fs.writeFileSync(p, `// ${n} ${tag}\n`); else fs.rmSync(p, { force: true });
  }
  for (const m of ['migrate-production-jobs-constraints', 'migrate-usage-events-costs']) {
    fs.writeFileSync(path.join(app, `scripts/${m}.js`), `require('fs').appendFileSync(process.env.CALLS, 'node ${m} ${tag}\\n');\n`);
  }
  fs.writeFileSync(path.join(app, 'scripts/prod/v2-schema-probes.js'), `require('fs').appendFileSync(process.env.CALLS, ['node v2-schema-probes ${tag}', ...process.argv.slice(2)].join(' ') + '\\n'); process.exit(Number(process.env.PROBES_EXIT || 0));\n`);
  const helper = path.join(app, 'scripts/pm2-drain-config.js');
  if (drainHelper) fs.copyFileSync(path.join(REPO, 'scripts/pm2-drain-config.js'), helper); else fs.rmSync(helper, { force: true });
  fs.copyFileSync(SH, path.join(app, 'scripts/ops/prod-release.sh'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'fake', tag }));
}
function runSh(vps, args, { input = '', env = {}, stdinScript = false } = {}) {
  const e = { PATH: `${vps.bin}:${process.env.PATH}`, HOME: vps.root, CALLS: vps.log, PM2_JLIST: vps.jlist, PM2_BIN: 'pm2',
    PM2_EXISTS: PROD_NAMES.join(' '), PROD_STABILITY_WINDOW_S: '0', ...env };
  fs.writeFileSync(vps.log, '');
  fs.rmSync(`${vps.jlist}.sleeps`, { force: true });
  const r = stdinScript
    ? spawnSync('bash', ['-s', '--', ...args], { cwd: vps.root, env: e, input: fs.readFileSync(SH), encoding: 'utf8' })
    : spawnSync('bash', [path.join(vps.app, 'scripts/ops/prod-release.sh'), ...args], { cwd: vps.app, env: e, input, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), calls: fs.readFileSync(vps.log, 'utf8').trim().split('\n').filter(Boolean) };
}
const cfgInput = (o = {}) => [o.token === undefined ? SECRET : o.token,
  `PROD_V2_CANARY_OWNER=${o.canary || ''}`, `PROD_V2_WORKERS_ENABLED=${o.workers || 'false'}`, `PROD_V2_GENERAL_AVAILABILITY=${o.ga || 'false'}`,
  `PROD_DB_POOL_MAX=${o.poolMax || ''}`, 'PROD_DB_POOL_MAX_WORKER=', 'PROD_DB_POOL_IDLE_MS_WORKER=',
  `PROD_SKIP_STORAGE_POLICY_PROBE=${o.skipStorage || 'false'}`, `DEPLOY_SHA=${o.sha || 'abcdef1'}`, ...(o.extra || [])].join('\n') + '\n';
const envOf = (app) => fs.readFileSync(path.join(app, '.env'), 'utf8');
const envMap = (app) => Object.fromEntries(envOf(app).split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

async function shellChecks() {
  await check('[SH] bash -n del script; sin «set -x»; nunca imprime el .env completo', () => {
    eq(spawnSync('bash', ['-n', SH]).status, 0, 'bash -n');
    const t = fs.readFileSync(SH, 'utf8');
    assert(!/set -x|cat \.env|printenv|(^|\s)env\s*\|/m.test(t), 'no vuelca el entorno');
  });

  const vps = mkFakeVps();
  try {
    writeRelease(vps.app, 'A');
    fs.writeFileSync(path.join(vps.app, '.env'), 'NODE_ENV=production\nDB_HOST=db.x.supabase.co\nDB_PASS=pw-secreta\nVIDEO_WORKER_ENABLED=true\nGAMMA_API_KEY=gk-secreta\n');

    await check('[SH] install sin canario: V2 apagado (DYNAMIC_COURSE_STRUCTURE=false si faltaba), workers de gasto OFF, TTS fijado, secreto escrito sin imprimirse, 2 migraciones de siempre, PM2 V1 + drenado, presencia, sondas', () => {
      const r = runSh(vps, ['install'], { input: cfgInput() });
      eq(r.status, 0, r.out);
      const env = envMap(vps.app);
      eq([env.DYNAMIC_COURSE_STRUCTURE, env.DYNAMIC_PROVIDER_WORKER_ENABLED, env.DYNAMIC_LLM_WORKER_ENABLED, env.OPENAI_TTS_MODEL, env.FINOPS_INGEST_TOKEN, env.DB_PASS],
        ['false', 'false', 'false', 'gpt-4o-mini-tts-2025-03-20', SECRET, 'pw-secreta'], 'flags');
      for (const k of ['DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION', 'PRESENTATION_LIGHT_DEFAULT_SINCE', 'DYNAMIC_PREBRIEF_REQUIRED_SINCE', 'DYNAMIC_LLM_WORKER_SINCE', 'DB_POOL_MAX']) {
        assert(!(k in env), `${k} no debe escribirse sin canario / sin variable`);
      }
      assert(!r.out.includes(SECRET) && !r.out.includes('pw-secreta') && !r.out.includes('nunca-impreso'), 'secretos impresos');
      assert(/DB_POOL_MAX ausente/.test(r.out), 'aviso de pool sin dimensionar');
      const calls = r.calls;
      const at = (s) => calls.findIndex((c) => c === s);
      assert(at('npm install --omit=dev') >= 0, 'npm install');
      assert(at('node migrate-production-jobs-constraints A') > at('npm install --omit=dev') && at('node migrate-usage-events-costs A') > 0, 'migraciones de siempre');
      assert(at('pm2 reload cursia-backend --update-env') > at('node migrate-usage-events-costs A'), 'PM2 después de migrar');
      for (const n of PROD_NAMES.slice(1, 8)) assert(calls.includes(`pm2 restart ${n} --update-env`), `legacy ${n}`);
      for (const n of PROD_NAMES.slice(8)) assert(calls.includes(`pm2 reload ${n} --update-env`) && !calls.includes(`pm2 delete ${n}`), `drenado ${n} ya configurado → reload`);
      assert(calls.indexOf('pm2 save') > calls.indexOf('pm2 reload cursia-dynamic-provider-worker --update-env'), 'pm2 save al final');
      assert(calls.includes('node v2-schema-probes A'), 'sondas de la base tras el deploy');
      assert(!calls.some((c) => /staging|videogen/.test(c)), 'no toca procesos ajenos');
      eq(fs.readFileSync(path.join(vps.app, '.release-sha'), 'utf8').trim(), 'abcdef1', '.release-sha');
      assert(/✓ cursia-dynamic-provider-worker/.test(r.out) && !/cursia-backend-staging/.test(r.out), 'presencia solo de los 11 de producción');
    });

    await check('[SH] install idempotente: segunda corrida no cambia el .env', () => {
      const before = envOf(vps.app);
      const r = runSh(vps, ['install'], { input: cfgInput() });
      eq(r.status, 0, r.out);
      eq(envOf(vps.app), before, '.env');
    });

    await check('[SH] proceso dinámico heredado (npm run, kill_timeout 1,6 s) → delete + start node directo --kill-timeout 300000 (UNA vez)', () => {
      const jl = JSON.parse(fs.readFileSync(vps.jlist, 'utf8'));
      const saved = JSON.stringify(jl);
      jl.find((p) => p.name === 'cursia-dynamic-item-worker').pm2_env = { status: 'online', restart_time: 0, pm_exec_path: '/usr/bin/npm', kill_timeout: 1600 };
      fs.writeFileSync(vps.jlist, JSON.stringify(jl));
      const r = runSh(vps, ['install'], { input: cfgInput() });
      fs.writeFileSync(vps.jlist, saved);
      eq(r.status, 0, r.out);
      assert(r.calls.includes('pm2 delete cursia-dynamic-item-worker') && r.calls.includes('pm2 start dist/workers/dynamic-item-worker.js --name cursia-dynamic-item-worker --kill-timeout 300000'), r.calls.join('\n'));
    });

    await check('[SH] install con canario + workers: V2 SOLO para el owner, reglas v3/actividad 2, instantes congelados, workers de gasto ON; DYNAMIC_WORKERS_HOLD=true los apaga', () => {
      let r = runSh(vps, ['install'], { input: cfgInput({ canary: OWNER, workers: 'true', poolMax: '2' }) });
      eq(r.status, 0, r.out);
      let env = envMap(vps.app);
      eq([env.DYNAMIC_COURSE_STRUCTURE, env.DYNAMIC_V2_ALLOWED_OWNERS, env.DYNAMIC_MANIFEST_RULES_VERSION, env.DYNAMIC_ACTIVITY_TYPE_RULES, env.DYNAMIC_VIDEO_DELIVERY,
        env.DYNAMIC_PROVIDER_WORKER_ENABLED, env.DYNAMIC_LLM_WORKER_ENABLED, env.DYNAMIC_LLM_WORKER_CONCURRENCY, env.DB_POOL_MAX],
      ['true', OWNER, '3', '2', 'youtube', 'true', 'true', '4', '2'], 'canario');
      const since = env.DYNAMIC_PREBRIEF_REQUIRED_SINCE;
      assert(/^\d{4}-\d\d-\d\dT/.test(since) && env.PRESENTATION_LIGHT_DEFAULT_SINCE && env.DYNAMIC_LLM_WORKER_SINCE, 'instantes');
      r = runSh(vps, ['install'], { input: cfgInput({ canary: OWNER, workers: 'true', poolMax: '2' }) });
      env = envMap(vps.app);
      eq([env.DYNAMIC_PREBRIEF_REQUIRED_SINCE, (envOf(vps.app).match(/^DYNAMIC_V2_ALLOWED_OWNERS=/gm) || []).length], [since, 1], 'congelado + sin duplicar');
      fs.appendFileSync(path.join(vps.app, '.env'), 'DYNAMIC_WORKERS_HOLD=true\n');
      r = runSh(vps, ['install'], { input: cfgInput({ canary: OWNER, workers: 'true' }) });
      env = envMap(vps.app);
      eq([r.status, env.DYNAMIC_PROVIDER_WORKER_ENABLED, env.DYNAMIC_LLM_WORKER_ENABLED], [0, 'false', 'false'], 'HOLD');
      // Sin canario otra vez: los workers de gasto se apagan; V2 (manual) queda con su allowlist.
      r = runSh(vps, ['install'], { input: cfgInput() });
      env = envMap(vps.app);
      eq([r.status, env.DYNAMIC_PROVIDER_WORKER_ENABLED, env.DYNAMIC_COURSE_STRUCTURE, env.DYNAMIC_V2_ALLOWED_OWNERS], [0, 'false', 'true', OWNER], 'sin canario');
    });

    await check('[SH] compuerta «V2 abierto a TODOS»: DYNAMIC_COURSE_STRUCTURE=true con allowlist vacía → falla ANTES de npm/PM2; PROD_V2_GENERAL_AVAILABILITY=true la permite', () => {
      fs.writeFileSync(path.join(vps.app, '.env'), 'NODE_ENV=production\nDYNAMIC_COURSE_STRUCTURE="true" # manual\nDYNAMIC_V2_ALLOWED_OWNERS=\n');
      let r = runSh(vps, ['install'], { input: cfgInput() });
      assert(r.status === 1 && /abierto a TODOS/.test(r.out), r.out);
      assert(!r.calls.some((c) => /^npm|^pm2 (reload|restart|start)/.test(c)), 'no instaló ni recargó nada');
      r = runSh(vps, ['preflight', vps.app], { stdinScript: true });
      assert(r.status === 1 && /abierto a TODOS/.test(r.out), `preflight: ${r.out}`);
      eq(runSh(vps, ['preflight', vps.app, OWNER], { stdinScript: true }).status, 0, 'preflight con canario (allowlist que el deploy va a escribir)');
      r = runSh(vps, ['install'], { input: cfgInput({ ga: 'true' }) });
      assert(r.status === 0 && /TODOS LOS OWNERS/.test(r.out), r.out);
    });

    await check('[SH] NODE_ENV≠production o sin .env → falla sin tocar nada (install y preflight por stdin); config inválida → falla', () => {
      fs.writeFileSync(path.join(vps.app, '.env'), 'NODE_ENV=development\n');
      let r = runSh(vps, ['install'], { input: cfgInput() });
      assert(r.status === 1 && /NODE_ENV=production/.test(r.out) && r.calls.length === 0, r.out);
      eq(envOf(vps.app), 'NODE_ENV=development\n', '.env intacto');
      r = runSh(vps, ['preflight', vps.app], { stdinScript: true });
      assert(r.status === 1 && /NODE_ENV=production/.test(r.out), r.out);
      fs.rmSync(path.join(vps.app, '.env'));
      r = runSh(vps, ['preflight', vps.app], { stdinScript: true });
      assert(r.status === 1 && /Falta \.env/.test(r.out), r.out);
      fs.writeFileSync(path.join(vps.app, '.env'), 'NODE_ENV=production\n');
      eq(runSh(vps, ['preflight', vps.app], { stdinScript: true }).status, 0, 'preflight ok');
      for (const [label, input] of [['uuid', cfgInput({ canary: 'x;id' })], ['bool', cfgInput({ workers: 'yes' })], ['clave', cfgInput({ extra: ['EVIL=1'] })],
        ['sha', cfgInput({ sha: 'zz' })], ['pool', cfgInput({ poolMax: '2 3' })]]) {
        const x = runSh(vps, ['install'], { input });
        assert(x.status === 1 && x.calls.length === 0, `${label}: ${x.status} ${x.out}`);
      }
      eq(runSh(vps, ['preflight', vps.app, 'no-uuid'], { stdinScript: true }).status, 1, 'preflight canario inválido');
      eq(runSh(vps, ['bogus'], { stdinScript: true }).status, 1, 'subcomando desconocido');
    });

    await check('[SH] crash loop en la ventana de estabilidad o proceso ausente → install falla (rollback sugerido); sondas de la base fallan → install falla', () => {
      let r = runSh(vps, ['install'], { input: cfgInput(), env: { BUMP_ON_SLEEP: '1' } });
      assert(r.status === 1 && /se reinició/.test(r.out) && /rollback/.test(r.out), r.out);
      const saved = fs.readFileSync(vps.jlist, 'utf8');
      fs.writeFileSync(vps.jlist, JSON.stringify(JSON.parse(saved).filter((p) => p.name !== 'cursia-h5p-worker')));
      r = runSh(vps, ['install'], { input: cfgInput() });
      fs.writeFileSync(vps.jlist, saved);
      assert(r.status === 1 && /cursia-h5p-worker.*NO EXISTE/.test(r.out), r.out);
      r = runSh(vps, ['install'], { input: cfgInput(), env: { PROBES_EXIT: '4' } });
      assert(r.status === 1 && /esquema V2 no está completo/.test(r.out), r.out);
    });

    await check('[SH] I1: workers V1 deshabilitados por su flag (VIDEO_WORKER_ENABLED≠true, GAMMA_API_KEY vacío) se DETIENEN y no cuentan en la presencia/estabilidad', () => {
      fs.writeFileSync(path.join(vps.app, '.env'), 'NODE_ENV=production\nVIDEO_WORKER_ENABLED=false\n');
      fs.rmSync(path.join(vps.app, '.release-state'), { force: true });
      const saved = fs.readFileSync(vps.jlist, 'utf8');
      // En PM2 quedan detenidos/errored (salen al arrancar): no deben tumbar el deploy.
      fs.writeFileSync(vps.jlist, JSON.stringify(JSON.parse(saved).map((p) => (['cursia-video-worker', 'cursia-gamma-worker'].includes(p.name) ? { ...p, pm2_env: { ...p.pm2_env, status: 'errored', restart_time: 40 } } : p))));
      const r = runSh(vps, ['install'], { input: cfgInput(), env: { BUMP_ON_SLEEP: '1', BUMP_NAME: 'cursia-video-worker' } });
      fs.writeFileSync(vps.jlist, saved);
      eq(r.status, 0, r.out);
      for (const n of ['cursia-video-worker', 'cursia-gamma-worker']) {
        assert(r.calls.includes(`pm2 stop ${n}`) && !r.calls.includes(`pm2 restart ${n} --update-env`), `${n} detenido, no reiniciado`);
      }
      assert(/detenidos a propósito, fuera de la presencia: cursia-video-worker cursia-gamma-worker/.test(r.out), r.out);
      assert(r.calls.includes('pm2 restart cursia-audio-worker --update-env'), 'los demás V1 igual que antes');
      eq(fs.existsSync(path.join(vps.app, '.release-state')), false, 'un install exitoso no marca failed');
    });

    await check('[SH] I1: worker V1 que YA se reiniciaba en bucle antes del deploy → aviso, no bloquea; uno que empieza a fallar DESPUÉS → install falla y deja «failed <sha>»', () => {
      fs.writeFileSync(path.join(vps.app, '.env'), 'NODE_ENV=production\nVIDEO_WORKER_ENABLED=true\nGAMMA_API_KEY=x\n');
      fs.writeFileSync(path.join(vps.app, '.release-state'), 'deploying abcdef1\n');
      let r = runSh(vps, ['install'], { input: cfgInput(), env: { BUMP_ON_SLEEP: '1', BUMP_NAME: 'cursia-audio-worker' } });
      eq(r.status, 0, r.out);
      assert(/cursia-audio-worker ya se reiniciaba en bucle ANTES del deploy/.test(r.out) && /inestables ya antes del deploy \(aviso, no bloquea\): cursia-audio-worker/.test(r.out), r.out);
      r = runSh(vps, ['install'], { input: cfgInput(), env: { BUMP_ON_SLEEP: '1', BUMP_NAME: 'cursia-audio-worker', BUMP_FROM: '2' } });
      assert(r.status === 1 && /cursia-audio-worker.*se reinició/.test(r.out), r.out);
      eq(fs.readFileSync(path.join(vps.app, '.release-state'), 'utf8').trim(), 'failed abcdef1', 'estado explícito para el operador / auto-rollback');
      fs.rmSync(path.join(vps.app, '.release-state'), { force: true });
    });

    await check('[SH] I3 + M1: reescribir el .env conserva su modo (0600, también .env.bak) y un secreto con barras invertidas / & se escribe literal, sin pasar por argv', () => {
      const p = path.join(vps.app, '.env');
      const tricky = 'tok\\n\\\\x&y\\t' + SECRET;
      fs.writeFileSync(p, 'NODE_ENV=production\nOPENAI_TTS_MODEL=gpt-4o-mini-tts\nFINOPS_INGEST_TOKEN=viejo\nVIDEO_WORKER_ENABLED=true\nGAMMA_API_KEY=x\n');
      fs.chmodSync(p, 0o600);
      fs.rmSync(path.join(vps.app, '.env.bak'), { force: true });
      const r = runSh(vps, ['install'], { input: cfgInput({ token: tricky }) });
      eq(r.status, 0, r.out);
      eq([fs.statSync(p).mode & 0o777, fs.statSync(path.join(vps.app, '.env.bak')).mode & 0o777], [0o600, 0o600], 'modo');
      const env = envMap(vps.app);
      eq([env.OPENAI_TTS_MODEL, env.FINOPS_INGEST_TOKEN], ['gpt-4o-mini-tts-2025-03-20', tricky], 'valores literales');
      assert(!r.out.includes(SECRET), 'secreto no impreso');
      const sh = fs.readFileSync(SH, 'utf8');
      assert(!/awk -v v=/.test(sh) && /ENVIRON\["_V"\]/.test(sh), 'M1: el valor viaja por ENVIRON, no por awk -v');
    });

    await check('[SH] M8: DYNAMIC_WORKERS_HOLD con comillas / CRLF / comentario sigue apagando los workers de gasto; M2: PROD_SKIP_STORAGE_POLICY_PROBE pasa --skip-storage-policies a las sondas', () => {
      for (const line of ['DYNAMIC_WORKERS_HOLD="true"', 'DYNAMIC_WORKERS_HOLD=true\r', 'DYNAMIC_WORKERS_HOLD=TRUE # pausa']) {
        fs.writeFileSync(path.join(vps.app, '.env'), `NODE_ENV=production\nVIDEO_WORKER_ENABLED=true\nGAMMA_API_KEY=x\n${line}\n`);
        const r = runSh(vps, ['install'], { input: cfgInput({ canary: OWNER, workers: 'true' }) });
        eq([r.status, envMap(vps.app).DYNAMIC_PROVIDER_WORKER_ENABLED], [0, 'false'], JSON.stringify(line));
      }
      let r = runSh(vps, ['install'], { input: cfgInput({ skipStorage: 'true' }) });
      assert(r.status === 0 && r.calls.includes('node v2-schema-probes A --skip-storage-policies') && /PROD_SKIP_STORAGE_POLICY_PROBE=true/.test(r.out), r.calls.join(' | '));
      r = runSh(vps, ['install'], { input: cfgInput() });
      assert(r.calls.includes('node v2-schema-probes A'), 'sin la variable: sondas completas');
      eq(runSh(vps, ['install'], { input: cfgInput({ skipStorage: 'si' }) }).status, 1, 'valor inválido');
      fs.writeFileSync(path.join(vps.app, '.env'), 'NODE_ENV=production\nVIDEO_WORKER_ENABLED=true\nGAMMA_API_KEY=x\n');
    });

    await check('[SH] ciclo de releases: snapshot (pre-r61) → mark-ok → snapshot; deploy a medias NO pisa el snapshot sano; rollback restaura (sin migrar; .env y node_modules intactos)', () => {
      const app = vps.app;
      fs.rmSync(path.join(app, '.release-sha'), { force: true });
      fs.rmSync(path.join(app, '.release-state'), { force: true });
      fs.mkdirSync(path.join(app, 'node_modules/pg'), { recursive: true });
      fs.writeFileSync(path.join(app, 'node_modules/pg/index.js'), '// pg');
      writeRelease(app, 'A');
      // 1) primera vez (release anterior a r61, sin .release-state): se guarda como pre-r61.
      let r = runSh(vps, ['snapshot', app, 'b0b0b0b'], { stdinScript: true });
      eq(r.status, 0, r.out);
      eq([fs.readFileSync(path.join(app, '.release-prev/dist/main.js'), 'utf8'), fs.readFileSync(path.join(app, '.release-prev/.release-sha'), 'utf8').trim(),
        fs.readFileSync(path.join(app, '.release-state'), 'utf8').trim()], ['// release A\n', 'pre-r61', 'deploying b0b0b0b'], 'snapshot A');
      assert(fs.existsSync(path.join(app, '.release-prev/node_modules/pg/index.js')) && !fs.existsSync(path.join(app, '.release-prev/.env')), 'con node_modules (M6), sin .env');
      // 2) deploy B ok.
      writeRelease(app, 'B');
      fs.writeFileSync(path.join(app, '.release-sha'), 'b0b0b0b\n');
      eq(runSh(vps, ['mark-ok', app, 'b0b0b0b'], { stdinScript: true }).status, 0, 'mark-ok');
      // 3) deploy C: snapshot guarda B; C queda a medias (nunca mark-ok).
      eq(runSh(vps, ['snapshot', app, 'c0c0c0c'], { stdinScript: true }).status, 0, 'snapshot C');
      eq(fs.readFileSync(path.join(app, '.release-prev/.release-sha'), 'utf8').trim(), 'b0b0b0b', 'prev = B');
      writeRelease(app, 'C');
      fs.writeFileSync(path.join(app, '.release-sha'), 'c0c0c0c\n');
      // 4) deploy D tras el fallo: el snapshot sano (B) NO se pisa con C.
      r = runSh(vps, ['snapshot', app, 'd0d0d0d'], { stdinScript: true });
      assert(r.status === 0 && /NO quedó marcada sana/.test(r.out), r.out);
      eq(fs.readFileSync(path.join(app, '.release-prev/dist/main.js'), 'utf8'), '// release B\n', 'prev sigue siendo B');
      // 5) rollback → B.
      const envBefore = envOf(app);
      r = runSh(vps, ['rollback', app], { stdinScript: true });
      eq(r.status, 0, r.out);
      eq([fs.readFileSync(path.join(app, 'dist/main.js'), 'utf8'), fs.readFileSync(path.join(app, '.release-sha'), 'utf8').trim(),
        fs.readFileSync(path.join(app, '.release-state'), 'utf8').trim(), fs.readFileSync(path.join(app, '.release-failed/dist/main.js'), 'utf8')],
      ['// release B\n', 'b0b0b0b', 'rolledback b0b0b0b', '// release C\n'], 'restaurado');
      eq(envOf(app), envBefore, '.env intacto');
      assert(fs.existsSync(path.join(app, 'node_modules/pg/index.js')), 'node_modules intacto');
      assert(!r.calls.includes('npm install --omit=dev') && !r.calls.some((c) => /migrate-/.test(c)), `sin npm (node_modules del snapshot) y sin migraciones: ${r.calls.join(' | ')}`);
      assert(!fs.existsSync(path.join(app, '.release-failed/node_modules')), 'la copia de diagnóstico no duplica node_modules');
      assert(r.calls.includes('pm2 reload cursia-backend --update-env') && r.calls.includes('pm2 save'), 'PM2 recargado');
      r = runSh(vps, ['mark-ok', app, 'restored'], { stdinScript: true });
      eq([r.status, fs.readFileSync(path.join(app, '.release-state'), 'utf8').trim()], [0, 'ok b0b0b0b'], 'mark-ok restored');
    });

    await check('[SH] rollback a una release pre-r61 (sin pm2-drain-config.js ni workers dinámicos): recarga V1, detiene los dinámicos y no los exige en la presencia; sin snapshot → falla clara', () => {
      const app = vps.app;
      writeRelease(path.join(app, '.release-prev'), 'V1', { drainHelper: false, dynamicWorkers: false });
      fs.writeFileSync(path.join(app, '.release-prev/.release-sha'), 'pre-r61\n');
      const jl = JSON.parse(fs.readFileSync(vps.jlist, 'utf8'));
      const saved = JSON.stringify(jl);
      fs.writeFileSync(vps.jlist, JSON.stringify(jl.map((p) => (p.name.startsWith('cursia-dynamic-') ? { ...p, pm2_env: { ...p.pm2_env, status: 'stopped' } } : p))));
      let r = runSh(vps, ['rollback', app], { stdinScript: true });
      fs.writeFileSync(vps.jlist, saved);
      eq(r.status, 0, r.out);
      for (const n of PROD_NAMES.slice(8)) assert(r.calls.includes(`pm2 stop ${n}`), `detiene ${n}`);
      assert(!fs.existsSync(path.join(app, 'dist/workers/dynamic-item-worker.js')), 'release V1 restaurada');
      r = runSh(vps, ['mark-ok', app, 'restored'], { stdinScript: true });
      eq([r.status, fs.readFileSync(path.join(app, '.release-state'), 'utf8').trim()], [0, 'ok pre-r61'], 'pre-r61 marcada sana');
      fs.rmSync(path.join(app, '.release-prev'), { recursive: true, force: true });
      r = runSh(vps, ['rollback', app], { stdinScript: true });
      assert(r.status === 1 && /no hay snapshot de rollback/.test(r.out), r.out);
    });
  } finally {
    fs.rmSync(vps.root, { recursive: true, force: true });
  }
}

(async () => {
  await workflowChecks();
  await gateCoreChecks();
  await shellChecks();
  console.log(`\n${passes} OK, ${failures} fallidos`);
  process.exit(failures ? 1 : 0);
})();
