#!/usr/bin/env node
/* eslint-disable */
// r60 (gap de producción «plan de migración incompleto») — el plan de producción de V2
// (scripts/prod/migrate-v2-production.js) debe cubrir TODA migración que corre deploy-staging.yml, porque el código
// que se promueve es el de staging (guardas schema_not_migrated_* y lecturas directas). Antes de r60 quedaban fuera
// 6 (pedagogy-profiles, practice-chapters, application-activities, guided-practice, academic-context, prebrief).
//
// Offline: solo lee archivos (no conecta a ninguna base, no corre ninguna migración).
//   (a) cada `node scripts/migrate-*.js` de deploy-staging.yml está en el plan (MIGRATION_STEPS por su .sql, o el
//       PASO 0 builtin), o es una de las excepciones documentadas que deploy.yml aplica en cada push a main;
//   (b) EXCLUDED no contiene ninguna migración que staging corre (salvo esas excepciones);
//   (c) el orden relativo del plan es el de staging (dependencias: CHECKs que se reescriben, kinds que se amplían),
//       salvo excepciones de orden documentadas;
//   (d) cada paso nombra en stagingStep el script de staging que aplica ese mismo .sql;
//   (e) el detector falla de verdad si se quita un paso o se invierte una dependencia (autoprueba).
//
// Usage: node scripts/check-r60-prod-migrations-cover-staging.js
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const runner = require(path.join(REPO, 'scripts/prod/migrate-v2-production.js'));

// Migraciones de staging que NO van en el plan V2 porque deploy.yml (producción) ya las aplica en cada push a main.
const APPLIED_BY_DEPLOY_YML = {
  'migrate-usage-events-costs.js': 'usage_events/cost_rates: no es V2, lo aplica deploy.yml',
};
// El PASO 0 del runner (builtin) es el SQL de esta migración (scripts/lib/production-jobs-constraints.js).
const BUILTIN_STEP0 = 'migrate-production-jobs-constraints.js';
// Pasos cuyo orden en producción difiere del de staging A PROPÓSITO (sin dependencias con los vecinos).
const ORDER_EXCEPTIONS = {
  'supabase-migration-ev6-h5p2.sql': 'courses.review_cards_enabled: columna aditiva independiente (nullable, default false); producción la aplica después de FinOps desde EV6',
};

let passes = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.message ? err.message : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }

/** Scripts migrate-*.js que corre un workflow, en orden de aparición. */
function workflowMigrations(yml) {
  const out = [];
  // Review M-3: cualquier aparición en la línea (env previos, `&&`, `if …; then node …`), no solo al inicio. Se ignoran
  // las líneas de comentario de shell.
  const re = /^(?![ \t]*#).*?\bnode\s+(?:\.\/)?scripts\/(migrate-[\w-]+\.js)\b/gm;
  let m;
  while ((m = re.exec(yml))) out.push(m[1]);
  return out;
}
/** .sql que aplica un scripts/migrate-*.js (el único supabase-migration-*.sql que nombra). */
function sqlOfScript(script) {
  const src = read(`scripts/${script}`);
  const files = [...new Set(src.match(/supabase-migration-[\w-]+\.sql/g) || [])];
  return files.length === 1 ? files[0] : null;
}

/** Hallazgos de cobertura/orden para un plan dado (puro: lo usa también la autoprueba). */
function coverageFindings(stagingScripts, plan) {
  const errs = [];
  const planFiles = plan.steps.map((s) => s.file);
  const excluded = new Map(plan.excluded.map((e) => [e.file, e.reason]));
  const stagingSql = [];
  for (const script of stagingScripts) {
    if (script === BUILTIN_STEP0) continue;
    if (APPLIED_BY_DEPLOY_YML[script]) continue;
    const sql = sqlOfScript(script);
    if (!sql) { errs.push(`${script}: no se pudo determinar su .sql (debe nombrar exactamente un supabase-migration-*.sql)`); continue; }
    stagingSql.push({ script, sql });
    if (!planFiles.includes(sql)) {
      errs.push(`${sql} (${script}) corre en deploy-staging.yml pero NO está en el plan de producción`
        + (excluded.has(sql) ? ` — está en EXCLUDED: «${excluded.get(sql)}»` : ''));
    }
    if (excluded.has(sql)) errs.push(`${sql} figura en EXCLUDED aunque staging la corre`);
    const step = plan.steps.find((s) => s.file === sql);
    if (step && !String(step.stagingStep || '').includes(script)) errs.push(`paso ${step.id}: stagingStep «${step.stagingStep}» no nombra ${script}`);
  }
  // Orden relativo: el de staging, salvo las excepciones documentadas.
  const order = (files) => files.filter((f) => !ORDER_EXCEPTIONS[f]);
  const stagingOrder = order(stagingSql.map((x) => x.sql).filter((f) => planFiles.includes(f)));
  const prodOrder = order(planFiles.filter((f) => stagingSql.some((x) => x.sql === f)));
  for (let i = 0; i < Math.max(stagingOrder.length, prodOrder.length); i++) {
    if (stagingOrder[i] !== prodOrder[i]) {
      errs.push(`orden distinto al de staging en la posición ${i + 1}: producción ${prodOrder[i]} / staging ${stagingOrder[i]}`);
      break;
    }
  }
  return errs;
}

const stagingYml = read('.github/workflows/deploy-staging.yml');
const deployYml = read('.github/workflows/deploy.yml');
const prodWf = read('.github/workflows/v2-production-migrations.yml');
const stagingScripts = workflowMigrations(stagingYml);
const plan = { steps: runner.MIGRATION_STEPS, excluded: runner.buildPlan ? (runner.buildPlan({ values: {}, flags: new Set() }).excluded || []) : [] };

check('deploy-staging.yml: se leen sus migraciones (≥ 20 scripts migrate-*.js)', () => {
  assert(stagingScripts.length >= 20, `solo ${stagingScripts.length}: ${stagingScripts.join(', ')}`);
  assert(stagingScripts.includes(BUILTIN_STEP0), `${BUILTIN_STEP0} no aparece en deploy-staging.yml`);
});

check('M-3: el parser encuentra migraciones en cualquier posición de la línea (y no en comentarios)', () => {
  const yml = [
    '  run: |',
    '    MIGRATION_ENV=staging node scripts/migrate-a.js',
    '    DB_SSL=true MIGRATION_ENV=staging node scripts/migrate-b.js && echo ok',
    '    if [ -n "$X" ]; then node ./scripts/migrate-c.js; fi',
    '    set -e; FOO=1 node scripts/migrate-d.js',
    '    # node scripts/migrate-commented.js',
  ].join('\n');
  const got = workflowMigrations(yml);
  assert(JSON.stringify(got) === JSON.stringify(['migrate-a.js', 'migrate-b.js', 'migrate-c.js', 'migrate-d.js']), JSON.stringify(got));
});

check('EXCLUDED del runner se lee (buildPlan().excluded)', () => {
  assert(Array.isArray(plan.excluded) && plan.excluded.length > 0, 'buildPlan no devolvió excluded');
});

check('(a)(b)(c)(d) el plan de producción cubre TODA migración de deploy-staging.yml, en su orden y sin EXCLUDED', () => {
  const errs = coverageFindings(stagingScripts, plan);
  assert(errs.length === 0, errs.join('\n   '));
});

check('las excepciones las aplica de verdad deploy.yml (y el PASO 0 es la misma lib)', () => {
  const prodScripts = workflowMigrations(deployYml);
  for (const s of Object.keys(APPLIED_BY_DEPLOY_YML)) assert(prodScripts.includes(s), `${s} no está en deploy.yml`);
  assert(/production-jobs-constraints/.test(runner.CONSTRAINTS_STEP.file), 'PASO 0 sin la lib de constraints');
  assert(/require\(['"][^'"]*lib\/production-jobs-constraints['"]\)/.test(read(`scripts/${BUILTIN_STEP0}`)), `${BUILTIN_STEP0} no usa scripts/lib/production-jobs-constraints`);
});

check('v2-production-migrations.yml usa el runner (la lista vive en un solo lugar)', () => {
  assert(/node scripts\/prod\/migrate-v2-production\.js --apply/.test(prodWf), 'el workflow no invoca el runner con --apply');
  assert(!/node scripts\/migrate-[\w-]+\.js/.test(prodWf), 'el workflow corre migraciones sueltas fuera del runner');
});

check('cada paso nuevo (r60) existe, es idempotente y no trae control de transacción propio', () => {
  for (const id of ['pedagogy-profiles', 'practice-chapters', 'application-activities', 'guided-practice', 'academic-context', 'prebrief']) {
    const step = runner.MIGRATION_STEPS.find((s) => s.id === id);
    assert(step, `falta el paso ${id}`);
    const sql = read(step.file);
    assert(/if not exists|position\(|pg_get_constraintdef|create or replace/i.test(sql), `${step.file}: sin guardas de idempotencia visibles`);
    assert(!/^\s*(begin|commit|rollback)\s*;/im.test(sql), `${step.file}: control de transacción propio`);
  }
});

check('(e) autoprueba: quitar un paso o invertir una dependencia SÍ se detecta', () => {
  const without = { ...plan, steps: plan.steps.filter((s) => s.id !== 'prebrief') };
  assert(coverageFindings(stagingScripts, without).some((e) => /supabase-migration-prebrief\.sql .*NO está en el plan/.test(e)), 'no detectó el paso faltante');
  const asExcluded = { steps: without.steps, excluded: plan.excluded.concat([{ file: 'supabase-migration-prebrief.sql', reason: 'solo staging' }]) };
  assert(coverageFindings(stagingScripts, asExcluded).some((e) => /EXCLUDED/.test(e)), 'no detectó EXCLUDED');
  const steps = plan.steps.slice();
  const a = steps.findIndex((s) => s.id === 'pedagogy-profiles');
  const b = steps.findIndex((s) => s.id === 'academic-context');
  [steps[a], steps[b]] = [steps[b], steps[a]];
  assert(coverageFindings(stagingScripts, { ...plan, steps }).some((e) => /orden distinto/.test(e)), 'no detectó el orden invertido');
});

console.log(`\n${passes} ok, ${failures} fail`);
process.exit(failures ? 1 : 0);
