#!/usr/bin/env node
/* eslint-disable */
// r62 (decisión del usuario, 2026-10-19) — AUTORIZACIÓN ÚNICA: el usuario autoriza el presupuesto UNA vez
// («Autorizar y generar», b1) y Cursia sigue sola dentro de la política. Un admin solo hace falta cuando el estimado
// excede la política, no hay política, a la política le falta un tope (por run, por curso o mensual), la política lo
// pide explícitamente (`limits.requireHumanApprovalForRealSpend: true`) o en las excepciones c5–c7 (techo del run,
// disyuntor, sobregasto), que NO cambian.
//
// Parte pura: decideRunBudget / evaluateBudget / policyFromRow / parsePolicyUpdate / planPolicyUpdate / decideRunSpend.
// Parte DB (PG16 desechable, mismo esquema que check-v21-finops-wiring): preview + approve-and-start de un NO admin
// dentro de la política (fila AUTO_WITHIN_POLICY firmada + vinculada, que sí cubre proveedores pagados), 409 sin firma,
// excede → admin, sin política → admin, flag explícito → admin, techo (c5) sigue pausando y no se reanuda sin ampliar,
// disyuntor (c6) sigue pausando, runs históricos sin cambios (runPaidAuthorizedBudget = la consulta de antes), endpoint
// de admin de políticas (validación, append-only, auditoría, solo SuperAdmin).
//
// Usage: node scripts/check-r62-single-authorization.js [--pure-only] [path/to/dist]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');

function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar ${abs} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
const F = loadDist('modules/finops/index.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg}: esperado ${y}, encontrado ${x}`);
}
function throwsCode(fn, code, msg) {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  assert(e && e.code === code, `${msg}: esperaba ${code}, fue ${e ? e.code + ' ' + e.message : 'sin error'}`);
  return e;
}
async function rejectsRe(p, re, msg, status) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
  assert(re.test(text), `${msg}: mensaje inesperado "${text}"`);
  if (status !== undefined) assert(err.getStatus && err.getStatus() === status, `${msg}: status ${err.getStatus && err.getStatus()} (esperado ${status})`);
  return err;
}
const dec = (x) => Number(x);

// ════════════════════════════════════════════════════════════════════════════
// Parte pura
// ════════════════════════════════════════════════════════════════════════════
const est = (min, expected, max, byProvider = {}) => ({ totals: { min, expected, max, byProvider, byItemType: {} } });
const CAPS = { maxCostPerRun: '20', maxCostPerCourse: '50', monthlyCap: '200', ownerMonthlyCap: '100' };
/** Política como la lee policyFor: la columna legacy es true en TODAS las filas existentes (NOT NULL DEFAULT true). */
const rowPolicy = (limits, onExceed = 'ADMIN_APPROVAL', column = true) => F.policyFromRow({ id: 'p1', version: 3, limits, require_human_approval_for_real_spend: column, on_exceed: onExceed });

async function pureChecks() {
  const E = est('2', '5', '9', { gamma: { min: '1', expected: '2', max: '4' }, openai: { min: '1', expected: '3', max: '5' } });

  await check('puro: dentro de la política (tope por run, por curso y mensual; columna legacy en true) + proveedores pagados → AUTO_WITHIN_POLICY con firma del usuario', () => {
    const p = rowPolicy(CAPS);
    eq([p.requireHumanApprovalForRealSpend, p.legacyRequireHumanColumn], [false, true], 'la columna legacy no es el flag explícito');
    const r = F.decideRunBudget({ estimate: E, policy: p, spentSoFar: { course: '0' }, paidRealProviders: ['gamma', 'openai'] });
    eq([r.decision, r.userAuthorizationRequired], ['AUTO_WITHIN_POLICY', true], 'decisión');
    assert(r.reasons.includes('within_policy') && r.reasons.includes('paid_real_provider_user_authorization:gamma,openai'), JSON.stringify(r.reasons));
    assert(!r.reasons.some((x) => /requires_admin/.test(x)), 'sin razón de admin');
    // monthlyCapStaging (clave histórica de staging) cuenta como tope mensual.
    const rs = F.decideRunBudget({ estimate: E, policy: rowPolicy({ maxCostPerRun: '20', maxCostPerCourse: '50', monthlyCapStaging: '200', ownerMonthlyCap: '100' }), paidRealProviders: ['gamma'] });
    eq(rs.decision, 'AUTO_WITHIN_POLICY', 'monthlyCapStaging (en staging)');
  });

  await check('puro: excede la política → ADMIN (on_exceed ADMIN_APPROVAL o banda esperado ≤ L < máx) o BLOCK (on_exceed BLOCK); nunca firma de usuario', () => {
    const over = F.decideRunBudget({ estimate: E, policy: rowPolicy({ ...CAPS, maxCostPerRun: '4' }), paidRealProviders: ['gamma'] });
    eq([over.decision, !!over.userAuthorizationRequired], ['ADMIN_APPROVAL', false], 'esperado sobre el límite');
    assert(over.reasons.some((x) => x.startsWith('maxCostPerRun:expected_over_limit')) && over.reasons.some((x) => x.startsWith('paid_real_provider_requires_admin_approval')), JSON.stringify(over.reasons));
    eq(F.decideRunBudget({ estimate: E, policy: rowPolicy({ ...CAPS, maxCostPerRun: '7' }), paidRealProviders: ['gamma'] }).decision, 'ADMIN_APPROVAL', 'banda');
    eq(F.decideRunBudget({ estimate: E, policy: rowPolicy({ ...CAPS, maxCostPerRun: '4' }, 'BLOCK'), paidRealProviders: ['gamma'] }).decision, 'BLOCK', 'on_exceed BLOCK');
    eq(F.decideRunBudget({ estimate: E, policy: rowPolicy({ ...CAPS, maxCostPerCourse: '10' }), spentSoFar: { course: '8' }, paidRealProviders: ['gamma'] }).decision, 'ADMIN_APPROVAL', 'curso con gasto previo');
    eq(F.decideRunBudget({ estimate: E, policy: rowPolicy({ ...CAPS, maxCostPerProvider: { gamma: '3' } }), paidRealProviders: ['gamma'] }).decision, 'ADMIN_APPROVAL', 'máximo del proveedor');
  });

  await check('puro: sin política → ADMIN; política sin algún tope (por run / por curso / mensual) → ADMIN nombrando lo que falta', () => {
    const none = F.decideRunBudget({ estimate: E, policy: null, paidRealProviders: ['videogen'] });
    eq([none.decision, !!none.userAuthorizationRequired], ['ADMIN_APPROVAL', false], 'sin política');
    assert(none.reasons.includes('no_budget_policy'), 'razón');
    for (const drop of ['maxCostPerRun', 'maxCostPerCourse', 'monthlyCap', 'ownerMonthlyCap']) {
      const l = { ...CAPS }; delete l[drop];
      const r = F.decideRunBudget({ estimate: E, policy: rowPolicy(l), paidRealProviders: ['gamma'] });
      eq(r.decision, 'ADMIN_APPROVAL', `sin ${drop}`);
      assert(r.reasons.some((x) => x === `policy_missing_caps_for_single_authorization:${drop}`), JSON.stringify(r.reasons));
    }
    eq(F.decideRunBudget({ estimate: E, policy: rowPolicy({}), paidRealProviders: ['gamma'] }).decision, 'ADMIN_APPROVAL', 'sin ningún tope');
  });

  await check('puro: flag EXPLÍCITO (limits.requireHumanApprovalForRealSpend: true) → ADMIN aunque entre en la política', () => {
    const p = rowPolicy({ ...CAPS, requireHumanApprovalForRealSpend: true });
    eq(p.requireHumanApprovalForRealSpend, true, 'explícito');
    const r = F.decideRunBudget({ estimate: E, policy: p, paidRealProviders: ['gamma'] });
    eq([r.decision, !!r.userAuthorizationRequired], ['ADMIN_APPROVAL', false], 'decisión');
    assert(r.reasons.includes('real_spend_requires_human_approval'), JSON.stringify(r.reasons));
    // evaluateBudget directo con el flag true (contrato de V2.1) sigue igual.
    eq(F.evaluateBudget({ estimate: est('0.1', '0.2', '0.3'), policy: { limits: CAPS, requireHumanApprovalForRealSpend: true }, realSpend: true }).decision, 'ADMIN_APPROVAL', 'evaluateBudget');
  });

  await check('puro: sin proveedores pagados (solo LLM / mock) → igual que antes: AUTO dentro de los límites, nunca BLOCK, sin firma', () => {
    const r = F.decideRunBudget({ estimate: E, policy: rowPolicy({ maxCostPerRun: '100' }), paidRealProviders: [] });
    eq([r.decision, !!r.userAuthorizationRequired], ['AUTO_WITHIN_POLICY', false], 'solo LLM con un tope');
    eq(F.decideRunBudget({ estimate: E, policy: rowPolicy({}), paidRealProviders: [] }).decision, 'AUTO_WITHIN_POLICY', 'solo LLM sin topes (sin reglas de admin)');
    eq(F.decideRunBudget({ estimate: E, policy: null, paidRealProviders: [] }).decision, 'AUTO_WITHIN_POLICY', 'sin política');
    eq(F.decideRunBudget({ estimate: E, policy: rowPolicy({ maxCostPerRun: '1' }, 'BLOCK'), paidRealProviders: [] }).decision, 'ADMIN_APPROVAL', 'LLM sobre el límite: ADMIN (nunca BLOCK)');
  });

  await check('puro: c5/c6 sin cambios — decideRunSpend sigue cortando en el techo autorizado (run_budget_cap) y en el disyuntor (circuit_breaker)', () => {
    const cap = F.decideRunSpend({ authorizedBudget: 10, runSpent: 9.5, nextCost: 1, itemSpent: 0, itemExpected: 1, itemEstimatedMax: 2, runExpected: 8, progressExpected: 8 });
    eq([cap.allow, cap.reason], [false, 'run_budget_cap'], 'techo');
    const br = F.decideRunSpend({ authorizedBudget: 100, runSpent: 10, nextCost: 1, itemSpent: 0, itemExpected: 1, itemEstimatedMax: 2, runExpected: 20, progressExpected: 2 });
    eq([br.allow, br.reason], [false, 'circuit_breaker'], 'disyuntor (1,5 × 2 + 3 = 6 < 11)');
    eq([F.BREAKER_RATIO, F.BREAKER_MIN_SLACK_USD], [1.5, 3], 'constantes del disyuntor intactas');
  });

  await check('puro (decisión 2026-10-20): la firma única exige ownerMonthlyCap (con él → AUTO, sin él → ADMIN); monthlyCapStaging solo cuenta como mensual en staging (pointsToProduction); fuera de staging sigue limitando', () => {
    eq(F.decideRunBudget({ estimate: E, policy: rowPolicy(CAPS), paidRealProviders: ['gamma'] }).decision, 'AUTO_WITHIN_POLICY', 'con ownerMonthlyCap');
    const { ownerMonthlyCap, ...noOwner } = CAPS;
    const r = F.decideRunBudget({ estimate: E, policy: rowPolicy(noOwner), paidRealProviders: ['gamma'] });
    eq(r.decision, 'ADMIN_APPROVAL', 'sin ownerMonthlyCap');
    assert(r.reasons.includes('policy_missing_caps_for_single_authorization:ownerMonthlyCap'), JSON.stringify(r.reasons));
    const stg = { maxCostPerRun: '20', maxCostPerCourse: '50', monthlyCapStaging: '200', ownerMonthlyCap: '100' };
    eq(F.policySpendCaps(rowPolicy(stg), { production: false }).missing, [], 'staging: monthlyCapStaging es el mensual');
    eq(F.policySpendCaps(rowPolicy(stg), { production: true }).missing, ['monthlyCap'], 'producción: monthlyCapStaging no cuenta');
    const saved = process.env.DB_HOST;
    process.env.DB_HOST = 'db.hriwbakbuypaiovvvkqh.supabase.co'; // detector de entorno (pointsToProduction); sin red
    try {
      const rp = F.decideRunBudget({ estimate: E, policy: rowPolicy(stg), paidRealProviders: ['gamma'] });
      eq(rp.decision, 'ADMIN_APPROVAL', 'producción con solo monthlyCapStaging → admin');
      assert(rp.reasons.includes('policy_missing_caps_for_single_authorization:monthlyCap'), JSON.stringify(rp.reasons));
      eq(F.decideRunBudget({ estimate: E, policy: rowPolicy({ ...stg, monthlyCap: '200' }), paidRealProviders: ['gamma'] }).decision, 'AUTO_WITHIN_POLICY', 'producción con monthlyCap → AUTO');
    } finally { if (saved === undefined) delete process.env.DB_HOST; else process.env.DB_HOST = saved; }
    // Fuera de staging, monthlyCapStaging sigue LIMITANDO el monto (fail-safe), aunque no habilite la firma única.
    const NA = F.planNormalApproval({ estimate: E, policy: rowPolicy({ monthlyCapStaging: '6' }), courseSpent: 0, monthSpent: 0 });
    eq([NA.withinPolicy, NA.amount, NA.cappedByLimit], [true, '6.0000000000', 'monthlyCap'], 'sigue acotando');
  });

  await check('puro (M4): el deploy de staging registra UNA versión con el marcador de la semántica r62 (auditoría); idempotente', () => {
    const SBP = require(path.join(REPO, 'scripts/staging-budget-policy.js'));
    const cur = { scope: 'global', scope_id: null, version: 7, limits: { maxCostPerRun: '106', maxCostPerCourse: '106', monthlyCapStaging: '162' }, on_exceed: 'ADMIN_APPROVAL', require_human_approval_for_real_spend: true };
    const p1 = SBP.withApprovalSemantics(cur, SBP.planPolicy(cur));
    eq([p1.action, p1.semanticsOnly, p1.row.version, p1.row.limits.approvalSemantics], ['insert', true, 8, SBP.APPROVAL_SEMANTICS], 'versión de auditoría');
    eq({ ...p1.row.limits, approvalSemantics: undefined }, { ...cur.limits, approvalSemantics: undefined }, 'límites iguales');
    assert(/r62/.test(p1.row.created_by) && /autorización única/.test(p1.row.created_by), p1.row.created_by);
    const after = { ...cur, version: 8, limits: p1.row.limits };
    eq(SBP.withApprovalSemantics(after, SBP.planPolicy(after)).action, 'noop', 'idempotente');
    const p2 = SBP.withApprovalSemantics(cur, SBP.planPolicy({ ...cur, limits: { ...cur.limits, maxCostPerRun: '10' } }));
    eq([p2.action, p2.row.limits.approvalSemantics], ['insert', SBP.APPROVAL_SEMANTICS], 'una versión con cambio de límites lleva el marcador');
    eq(SBP.withApprovalSemantics(null, SBP.planPolicy(null)).action, 'none', 'sin política no inventa');
    const dec2 = (l) => F.decideRunBudget({ estimate: est('2', '5', '9', { gamma: { min: '1', expected: '2', max: '4' } }), policy: rowPolicy(l), paidRealProviders: ['gamma'] }).decision;
    eq(dec2(p1.row.limits), dec2(cur.limits), 'el marcador no cambia la decisión');
    eq(dec2({ ...p1.row.limits, ownerMonthlyCap: '500' }), 'AUTO_WITHIN_POLICY', 'con el tope por cliente: firma única');
  });

  await check('puro (d12): parsePolicyUpdate valida scope/scopeId/limits/onExceed/flag/reason; planPolicyUpdate = parche append-only (versión+1, null quita, noop, auditoría en created_by)', () => {
    const P = (b) => F.parsePolicyUpdate(b);
    throwsCode(() => P({ scope: 'institution', reason: 'motivo largo', limits: { maxCostPerRun: 1 } }), 'INVALID_INPUT', 'scope no soportado');
    throwsCode(() => P({ scope: 'course', scopeId: 'abc', reason: 'motivo largo', limits: { maxCostPerRun: 1 } }), 'INVALID_INPUT', 'scopeId curso');
    throwsCode(() => P({ scope: 'owner', scopeId: '12', reason: 'motivo largo', limits: { maxCostPerRun: 1 } }), 'INVALID_INPUT', 'scopeId owner');
    throwsCode(() => P({ scope: 'global', scopeId: '1', reason: 'motivo largo', limits: { maxCostPerRun: 1 } }), 'INVALID_INPUT', 'global sin scopeId');
    throwsCode(() => P({ scope: 'global', reason: 'motivo largo', limits: { maxCostPerRun: -1 } }), 'INVALID_INPUT', 'negativo');
    throwsCode(() => P({ scope: 'global', reason: 'motivo largo', limits: { maxCostPerRun: 'mucho' } }), 'INVALID_INPUT', 'no decimal');
    // Review I1: notación científica / NaN / Infinity / más de 10 decimales se rechazan; se guarda el decimal normalizado.
    for (const v of [1e-20, 1e21, '1e3', NaN, Infinity, '0.12345678901', ' ', '1,5', '+3']) {
      throwsCode(() => P({ scope: 'global', reason: 'motivo largo', limits: { maxCostPerRun: v } }), 'INVALID_INPUT', `valor ${String(v)}`);
    }
    eq(P({ scope: 'global', reason: 'motivo largo', limits: { maxCostPerRun: '106.50', maxCostPerCourse: 75.5, monthlyCap: '0162' } }).limits,
      { maxCostPerRun: '106.5', maxCostPerCourse: '75.5', monthlyCap: '162' }, 'decimal normalizado (lo que el evaluador relee)');
    for (const v of Object.values(P({ scope: 'global', reason: 'motivo largo', limits: { maxCostPerRun: '0.0000000001', maxCostPerCourse: 100000 } }).limits)) F.normalizeDecimal(v);
    throwsCode(() => P({ scope: 'global', reason: 'motivo largo', limits: { maxCostPerRun: '100001' } }), 'INVALID_INPUT', 'cota de cordura');
    throwsCode(() => P({ scope: 'global', reason: 'motivo largo', limits: { inventado: 1 } }), 'INVALID_INPUT', 'tope desconocido');
    throwsCode(() => P({ scope: 'global', reason: 'motivo largo', limits: { requireHumanApprovalForRealSpend: true } }), 'INVALID_INPUT', 'flag dentro de limits');
    throwsCode(() => P({ scope: 'global', limits: { maxCostPerRun: 1 } }), 'INVALID_INPUT', 'sin reason');
    throwsCode(() => P({ scope: 'global', reason: 'motivo largo' }), 'INVALID_INPUT', 'nada que cambiar');
    throwsCode(() => P({ scope: 'global', reason: 'motivo largo', limits: { maxCostPerRun: 1 }, onExceed: 'IGNORE' }), 'INVALID_INPUT', 'onExceed');
    throwsCode(() => P({ scope: 'global', reason: 'motivo largo', limits: { maxCostPerRun: 1 }, extra: 1 }), 'INVALID_INPUT', 'campo extra');
    const cur = { id: 'x', scope: 'course', scope_id: '7', version: 4, limits: { maxCostPerRun: '106', maxCostPerCourse: '106', monthlyCapStaging: '162', maxCostPerProvider: { gamma: '4' } }, require_human_approval_for_real_spend: true, on_exceed: 'ADMIN_APPROVAL' };
    const req = P({ scope: 'course', scopeId: 7, limits: { monthlyCapStaging: '300', maxCostPerProvider: null }, reason: 'tope mensual alcanzado (d12)' });
    const plan = F.planPolicyUpdate(cur, req, 'admin@cursia.test');
    eq(plan.action, 'insert', 'inserta');
    eq([plan.row.scope, plan.row.scope_id, plan.row.version, plan.row.on_exceed, plan.row.require_human_approval_for_real_spend], ['course', '7', 5, 'ADMIN_APPROVAL', false], 'versión nueva');
    eq(plan.row.limits, { maxCostPerRun: '106', maxCostPerCourse: '106', monthlyCapStaging: '300' }, 'parche (null quita el tope por proveedor; el resto igual)');
    assert(/^admin_policy_update:admin@cursia\.test · tope mensual alcanzado/.test(plan.row.created_by), plan.row.created_by);
    const exp = F.planPolicyUpdate(cur, P({ scope: 'course', scopeId: '7', requireHumanApprovalForRealSpend: true, reason: 'cliente nuevo: admin' }), 'a@b');
    eq([exp.row.limits.requireHumanApprovalForRealSpend, exp.row.require_human_approval_for_real_spend], [true, true], 'flag explícito en limits y columna');
    const same = { ...cur, limits: { ...cur.limits }, require_human_approval_for_real_spend: false };
    eq(F.planPolicyUpdate(same, P({ scope: 'course', scopeId: '7', limits: { maxCostPerRun: 106 }, reason: 'reaplicar igual' }), 'a@b').action, 'noop', 'sin cambios → noop');
    throwsCode(() => F.planPolicyUpdate(null, P({ scope: 'owner', scopeId: crypto.randomUUID(), limits: { maxCostPerRun: 5 }, reason: 'nueva sin topes' }), 'a@b'), 'INVALID_INPUT', 'política nueva sin los tres topes');
    eq(F.planPolicyUpdate(null, P({ scope: 'global', limits: CAPS, reason: 'global inicial' }), 'a@b').row.version, 1, 'política nueva con los cuatro topes');
    throwsCode(() => F.planPolicyUpdate(null, P({ scope: 'global', limits: { maxCostPerRun: '1', maxCostPerCourse: '1', monthlyCap: '1' }, reason: 'sin tope por cliente' }), 'a@b'), 'INVALID_INPUT', 'nueva sin ownerMonthlyCap');
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Parte DB: Postgres 16 desechable
// ════════════════════════════════════════════════════════════════════════════
function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b16\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => (port === 5570 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

const OWNER = '11111111-2222-4333-8444-555555555555';
const CONTEXT = { nombre: 'Curso r62', sector: 'Salud', pais: 'Chile', contexto: 'x', nivel: 'Básico', tono: 'Formal' };
// Gamma/TTS reales por default (videos de vista previa): proveedores pagados reales ⇒ hace falta autorizar.
const NCTX = { ...CONTEXT, videoMode: 'mock' };
const MOCK_CTX = { ...CONTEXT, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } };
const ENV_KEYS = [
  'DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_GENERAL_AVAILABILITY', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_REAL_VIDEO_OWNERS', 'DYNAMIC_MANIFEST_RULES_VERSION',
  'DYNAMIC_VIDEO_DELIVERY', 'DYNAMIC_ALLOW_VIDEOGEN_DIRECT', 'VIDEOGEN_API_KEY', 'ALLOW_UNOWNED_COURSES',
  'DYNAMIC_PROVIDER_WORKER_ENABLED', 'DYNAMIC_ALLOW_PROVIDER_MOCK', 'SUPER_ADMIN_EMAILS', 'DYNAMIC_ALLOW_VIDEO_PREVIEW',
];

async function dbChecks() {
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
  const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
  const { FinopsAdminController } = loadDist('modules/finops/finops.controller.js');
  const { SuperAdminGuard } = loadDist('auth/super-admin.guard.js');
  const LUI = loadDist('modules/finops/llm-usage-ingest.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r62-pg16-'));
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r62-cwd-'));
  const ROLE = 'postgres.r62localtest01';
  const DB = 'r62db';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`\nPostgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', async (c) => {
      await c.query(`create database ${DB}`);
      await c.query(`create role "${ROLE}" superuser login`);
    });
    const localEnv = (extra) => ({ DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: ROLE, DB_PASS: 'x', DB_NAME: DB, DB_SSL: 'false', ...extra });
    const runScript = (script, env) => {
      const res = spawnSync(process.execPath, [path.join(REPO, script)], { cwd: tmpCwd, env: cleanEnv(env), encoding: 'utf8', timeout: 120000 });
      return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
    };
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-generation-manifests.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    {
      const res = runScript('scripts/migrate-production-jobs-constraints.js', localEnv({}));
      assert(res.code === 0, `constraints: ${res.out}`);
    }
    await withClient(DB, async (c) => {
      for (const f of ['supabase-migration-dynamic-generation.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    for (const s of ['scripts/migrate-dynamic-generation-v2.js', 'scripts/migrate-invalidation.js', 'scripts/migrate-v21-manifest-v3.js',
      'scripts/migrate-v21-finops.js', 'scripts/migrate-run-pause.js']) {
      if (!fs.existsSync(path.join(REPO, s))) continue;
      const res = runScript(s, localEnv({ MIGRATION_ENV: 'staging' }));
      assert(res.code === 0, `${s}: exit ${res.code}\n${res.out.slice(-2000)}`);
    }

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    process.env.DYNAMIC_V2_GENERAL_AVAILABILITY = 'true'; // fail closed: sin lista, V2 solo con habilitación pública explícita
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_VIDEO_DELIVERY = 'youtube';
    require('./lib/provider-test-env').applyFakeProviderEnv();
    process.env.DYNAMIC_ALLOW_VIDEOGEN_DIRECT = 'true';
    process.env.VIDEOGEN_API_KEY = 'fake-key-never-used-no-network';
    process.env.DYNAMIC_PROVIDER_WORKER_ENABLED = 'true';
    process.env.DYNAMIC_ALLOW_PROVIDER_MOCK = 'true';
    process.env.DYNAMIC_ALLOW_VIDEO_PREVIEW = 'true';
    process.env.SUPER_ADMIN_EMAILS = 'admin@cursia.test';

    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const blueprints = new CourseBlueprintsService(ds);
    const manifests = new GenerationManifestsService(ds, blueprints);
    const ledger = new F.FinopsLedgerService(ds);
    const budget = new F.FinopsBudgetService(ds, ledger);
    const runs = new RunsService(ds, manifests, {}, { async check() { return { ok: true }; } }, budget);
    const admin = new FinopsAdminController(ledger, budget);
    const ADMIN = { id: OWNER, email: 'admin@cursia.test' };
    const USER = { id: OWNER, email: 'docente@cliente.test' };

    async function makeCourse(title) {
      const [course] = await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]);
      const cid = course.id;
      const m1 = crypto.randomUUID();
      const c1 = crypto.randomUUID();
      const c2 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2(
        { id: cid, title, finalExam: true, activityEngine: 'h5p' },
        [{ id: m1, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [{ id: c1, module_id: m1, position: 0, title: 'C1', objective: null, video_enabled: true, activity_enabled: true },
          { id: c2, module_id: m1, position: 1, title: 'C2', objective: null, video_enabled: true, activity_enabled: false }],
      );
      for (const m of s2.modules) {
        await ds.query(`insert into public.course_modules (id, course_id, position, title) values ($1, $2, $3, $4)`, [m.id, cid, m.position, m.title]);
        for (const c of m.chapters) {
          await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled)
                          values ($1, $2, $3, $4, $5, $6, $7)`, [c.id, cid, m.id, c.position, c.title, c.videoEnabled, c.activityEnabled]);
        }
      }
      await ds.query(
        `insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
         values ($1, 1, 2, $2::jsonb, $3, 0, 1, 2)`, [cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      const res = await manifests.getOrCreate(cid, OWNER, 1);
      return { cid, c1, c2, m1, manifest: res.manifest };
    }
    // Política como las existentes: la columna legacy en su default (true) — la decisión NO la mira.
    const coursePolicy = (cid, limits, onExceed = 'ADMIN_APPROVAL') => ds.query(
      `insert into public.cost_budget_policies (scope, scope_id, version, limits, on_exceed) values ('course', $1, 1, $2::jsonb, $3) returning id`,
      [String(cid), JSON.stringify(limits), onExceed]);
    const BIG = { maxCostPerRun: '1000', maxCostPerCourse: '1000', monthlyCap: '1000000000', ownerMonthlyCap: '1000000000' };
    const authRows = (cid) => ds.query(`select id, run_id, estimate_id, decision, approved_by, reason, authorized_budget::text as b from public.cost_budget_authorizations where course_id = $1 order by created_at, (run_id is not null), id`, [cid]);
    const runCount = async (cid) => (await ds.query(`select count(*)::int n from public.production_jobs where course_id = $1`, [cid]))[0].n;
    /** La consulta de runPaidAuthorizedBudget ANTES de r62 (solo ADMIN_APPROVED / BLOCKED). */
    const oldPaidAuthorized = async (runId) => {
      const [row] = await ds.query(`select decision, authorized_budget::text as authorized_budget from public.cost_budget_authorizations
        where run_id = $1 and decision in ('ADMIN_APPROVED', 'BLOCKED') order by created_at desc, id desc limit 1`, [runId]);
      return !row || row.decision !== 'ADMIN_APPROVED' ? null : row.authorized_budget;
    };

    // ── Runs «históricos»: creados con el modelo de antes (admin explícito / mock AUTO) ANTES de cualquier firma r62 ──
    const H1 = await makeCourse('Histórico admin');
    await coursePolicy(H1.cid, { ...BIG, requireHumanApprovalForRealSpend: true });
    const pvH1 = await runs.previewStart(H1.cid, ADMIN, 1, NCTX);
    const runH1 = (await runs.approveAndStart(H1.cid, ADMIN, 1, NCTX, pvH1.estimateHash)).run.id;
    const H2 = await makeCourse('Histórico mock');
    const runH2 = (await runs.startRun(H2.cid, OWNER, 1, MOCK_CTX)).run.id;
    const histBefore = {};
    for (const id of [runH1, runH2]) histBefore[id] = { paid: await budget.runPaidAuthorizedBudget(id), any: await budget.runAuthorizedBudget(id), rows: (await ds.query(`select count(*)::int n from public.cost_budget_authorizations where run_id = $1`, [id]))[0].n };

    // ════ A: dentro de la política → AUTO + firma del usuario (sin admin) ════
    const A = await makeCourse('Dentro de la política');
    const [polA] = await coursePolicy(A.cid, BIG);
    let pvA = null;
    let runA = null;
    await check('DB dentro de la política: preview de un NO admin → decision AUTO_WITHIN_POLICY, mode user, userAuthorizationRequired, sin «required» de admin; monto = plan de la política; límites visibles', async () => {
      pvA = await runs.previewStart(A.cid, USER, 1, NCTX);
      eq([pvA.decision, pvA.approval.mode, pvA.approval.userAuthorizationRequired, pvA.approval.required, pvA.approval.canApprove, pvA.approval.withinPolicy],
        ['AUTO_WITHIN_POLICY', 'user', true, false, false, true], 'decisión');
      eq(dec(pvA.approval.amount), dec(pvA.estimate.max), 'monto = máx (límites holgados)');
      eq([pvA.policy.maxCostPerRun, pvA.policy.maxCostPerCourse, pvA.policy.monthlyCap].map(dec), [1000, 1000, 1000000000], 'límites');
      eq(pvA.paidRealProviders, ['gamma', 'openai'], 'proveedores pagados');
    });

    await check('DB sin la firma: startRun directo → 409 user_authorization_required (estimado guardado, sin run, sin autorización)', async () => {
      await rejectsRe(runs.startRun(A.cid, OWNER, 1, NCTX), /user_authorization_required/, 'sin firma', 409);
      eq(await runCount(A.cid), 0, 'sin run');
      eq((await authRows(A.cid)).length, 0, 'sin autorizaciones');
    });

    await check('DB «Autorizar y generar» de un NO admin → run creado + fila AUTO_WITHIN_POLICY firmada (email, huella, política) + vinculada; cubre proveedores pagados', async () => {
      await rejectsRe(runs.approveAndStart(A.cid, USER, 1, NCTX, 'f'.repeat(64)), /estimate_stale/, 'huella vieja', 409);
      const res = await runs.approveAndStart(A.cid, USER, 1, NCTX, pvA.estimateHash);
      eq([res.created, dec(res.approval.amount)], [true, dec(pvA.approval.amount)], 'creado');
      runA = res.run.id;
      const rows = await authRows(A.cid);
      eq(rows.map((x) => [x.decision, x.run_id === null, x.approved_by]), [['AUTO_WITHIN_POLICY', true, 'docente@cliente.test'], ['AUTO_WITHIN_POLICY', false, 'docente@cliente.test']], 'filas');
      eq(rows[0].reason, `user_authorized_within_policy:${pvA.estimateHash}`, 'huella');
      eq(rows[1].reason, `bound_from:${rows[0].id}`, 'vinculada');
      eq(rows[1].estimate_id, rows[0].estimate_id, 'mismo estimado');
      const [pol] = await ds.query(`select policy_id from public.cost_budget_authorizations where id = $1`, [rows[0].id]);
      eq(pol.policy_id, polA.id, 'política vigente registrada');
      eq(dec(await budget.runPaidAuthorizedBudget(runA)), dec(pvA.approval.amount), 'cubre proveedores pagados');
      eq(rows.filter((x) => x.decision === 'ADMIN_APPROVED').length, 0, 'ninguna aprobación de admin');
      eq(await budget.findUnconsumedApproval(A.cid, A.manifest.id, '0'), null, 'nada colgado');
    });

    await check('DB guard de envío pagado (Gamma) en el run autorizado por el usuario → permitido dentro del monto; una AUTO sin firma posterior NO lo amplía', async () => {
      const [it] = await ds.query(`select id from public.generation_item_runs where job_id = $1 and type = 'presentation' order by item_key limit 1`, [runA]);
      const g = await budget.guardPaidSubmission({ runId: runA, itemRunId: it.id, itemType: 'presentation' });
      eq([g.allow, dec(g.authorizedBudget)], [true, dec(pvA.approval.amount)], `guard (${g.reason})`);
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, decision, reason) values ($1, $2, 99999, 'AUTO_WITHIN_POLICY', 'auto_within_policy:test')`, [runA, A.cid]);
      eq(dec(await budget.runPaidAuthorizedBudget(runA)), dec(pvA.approval.amount), 'la AUTO sin firma no cuenta');
      // Una AUTO con approved_by pero sin la fila firmada de origen tampoco (no se falsifica con un reason).
      await ds.query(`insert into public.cost_budget_authorizations (run_id, course_id, authorized_budget, decision, approved_by, reason) values ($1, $2, 88888, 'AUTO_WITHIN_POLICY', 'x@y', $3)`, [runA, A.cid, `bound_from:${crypto.randomUUID()}`]);
      eq(dec(await budget.runPaidAuthorizedBudget(runA)), dec(pvA.approval.amount), 'bound_from sin origen firmado no cuenta');
    });

    await check('DB doble clic → el MISMO run, sin firmas nuevas', async () => {
      const n0 = (await authRows(A.cid)).length;
      const again = await runs.approveAndStart(A.cid, USER, 1, NCTX, pvA.estimateHash);
      eq([again.created, again.run.id], [false, runA], 'mismo run');
      eq((await authRows(A.cid)).length, n0, 'sin filas nuevas');
    });

    // ════ B: excede → admin; sin política → admin; flag explícito → admin; tope faltante → admin ════
    await check('DB excede la política (esperado > maxCostPerRun, on_exceed ADMIN_APPROVAL) → ADMIN; el NO admin recibe 403 approval_forbidden; nada creado', async () => {
      const B = await makeCourse('Excede');
      await coursePolicy(B.cid, { ...BIG, maxCostPerRun: '0.000001' });
      const pv = await runs.previewStart(B.cid, USER, 1, NCTX);
      eq([pv.decision, pv.approval.mode, pv.approval.userAuthorizationRequired, pv.approval.required], ['ADMIN_APPROVAL', 'admin', false, true], 'decisión');
      await rejectsRe(runs.approveAndStart(B.cid, USER, 1, NCTX, pv.estimateHash), /approval_forbidden/, 'no admin', 403);
      await rejectsRe(runs.approveAndStart(B.cid, ADMIN, 1, NCTX, (await runs.previewStart(B.cid, ADMIN, 1, NCTX)).estimateHash), /budget_blocked/, 'admin: fuera de la política = cambiar la política', 409);
      eq(await runCount(B.cid), 0, 'sin run');
    });

    await check('DB sin política → ADMIN (budget_blocked no_budget_policy para el admin; 403 para el usuario)', async () => {
      const N = await makeCourse('Sin política');
      const pv = await runs.previewStart(N.cid, USER, 1, NCTX);
      eq([pv.decision, pv.approval.mode, pv.approval.userAuthorizationRequired], ['ADMIN_APPROVAL', 'admin', false], 'decisión');
      assert(pv.reasons.includes('no_budget_policy'), JSON.stringify(pv.reasons));
      await rejectsRe(runs.approveAndStart(N.cid, USER, 1, NCTX, pv.estimateHash), /approval_forbidden/, 'no admin', 403);
      await rejectsRe(runs.startRun(N.cid, OWNER, 1, NCTX), /budget_approval_required/, 'start directo', 409);
      eq(await runCount(N.cid), 0, 'sin run');
    });

    await check('DB flag explícito (limits.requireHumanApprovalForRealSpend: true) → ADMIN aunque entre; el admin aprueba como siempre (ADMIN_APPROVED)', async () => {
      const X = await makeCourse('Flag explícito');
      await coursePolicy(X.cid, { ...BIG, requireHumanApprovalForRealSpend: true });
      const pv = await runs.previewStart(X.cid, USER, 1, NCTX);
      eq([pv.decision, pv.approval.mode, pv.approval.required], ['ADMIN_APPROVAL', 'admin', true], 'decisión');
      await rejectsRe(runs.approveAndStart(X.cid, USER, 1, NCTX, pv.estimateHash), /approval_forbidden/, 'no admin', 403);
      const pa = await runs.previewStart(X.cid, ADMIN, 1, NCTX);
      const res = await runs.approveAndStart(X.cid, ADMIN, 1, NCTX, pa.estimateHash);
      eq((await authRows(X.cid)).map((x) => x.decision), ['ADMIN_APPROVED', 'ADMIN_APPROVED'], 'camino de admin intacto');
      assert(res.created, 'creado');
    });

    await check('DB política sin tope mensual → ADMIN (policy_missing_caps_for_single_authorization:monthlyCap)', async () => {
      const Mc = await makeCourse('Sin mensual');
      await coursePolicy(Mc.cid, { maxCostPerRun: '1000', maxCostPerCourse: '1000', ownerMonthlyCap: '1000000000' }); // falta solo el mensual
      const pv = await runs.previewStart(Mc.cid, USER, 1, NCTX);
      eq([pv.decision, pv.approval.mode], ['ADMIN_APPROVAL', 'admin'], 'decisión');
      assert(pv.reasons.includes('policy_missing_caps_for_single_authorization:monthlyCap'), JSON.stringify(pv.reasons));
    });

    await check('DB mes agotado con decisión AUTO → bloqueado (budget_blocked monthlyCap), la firma no se escribe', async () => {
      const Mo = await makeCourse('Mes agotado');
      await coursePolicy(Mo.cid, { maxCostPerRun: '1000', maxCostPerCourse: '1000', monthlyCap: '0.000001', ownerMonthlyCap: '1000000000' });
      const pv = await runs.previewStart(Mo.cid, USER, 1, NCTX);
      eq([pv.approval.mode, pv.approval.withinPolicy], ['user', false], 'mode user pero fuera del plan');
      await rejectsRe(runs.approveAndStart(Mo.cid, USER, 1, NCTX, pv.estimateHash), /budget_blocked.*monthlyCap/, 'mes', 409);
      eq((await authRows(Mo.cid)).length, 0, 'sin firma');
    });

    // ════ c5 / c6 sobre runs autorizados por el usuario ════
    await check('DB c5: el techo en ejecución sigue pausando — reservas hasta el monto firmado y la siguiente → RUN_BUDGET_CAP; guard con pauseOnCap → run pausado (run_budget_cap); reanudar sin ampliar → 409', async () => {
      const C = await makeCourse('Techo c5');
      await coursePolicy(C.cid, BIG);
      const pv = await runs.previewStart(C.cid, USER, 1, NCTX);
      const runC = (await runs.approveAndStart(C.cid, USER, 1, NCTX, pv.estimateHash)).run.id;
      const [it] = await ds.query(`select id from public.generation_item_runs where job_id = $1 and type = 'content' order by item_key limit 1`, [runC]);
      const resInput = (tag) => ({
        itemRunId: it.id, ownerIdFromAuth: OWNER, provider: 'anthropic', service: 'messages', modelOrProduct: 'claude-sonnet-4-6',
        usage: LUI.llmCallUpperBoundUsage(30000, 12000), usageUnit: 'output_tokens', externalOperationId: null,
        idempotencyKey: `reservation:r62:${it.id}:${tag}`, callRole: 'main', attempt: 1, billingAccount: 'cursia', mode: 'real',
        costSource: 'CALCULATED_FROM_USAGE', measurementStatus: 'pending', pricingFallback: 'pending_zero', recordedBy: 'check-r62',
        metadata: { reservation: true, callTag: tag },
      });
      let capErr = null;
      for (let i = 0; i < 2000 && !capErr; i++) {
        try { await ledger.recordCharge(resInput('r' + i)); } catch (e) { capErr = e; }
      }
      assert(capErr && capErr.code === 'RUN_BUDGET_CAP', `RUN_BUDGET_CAP (${capErr && capErr.code})`);
      eq(dec(capErr.details.authorizedBudget), dec(pv.approval.amount), 'el techo es el monto firmado');
      const [t] = await ds.query(`select coalesce(sum(amount),0)::text t from public.generation_cost_events where run_id = $1`, [runC]);
      assert(dec(t.t) <= dec(pv.approval.amount) + 1e-9, 'nunca supera el monto firmado');
      const g = await budget.guardRunSpend({ runId: runC, itemRunId: null, nextCost: 1, authorizedBudget: dec(pv.approval.amount), pauseOnCap: true });
      eq([g.decision.allow, g.decision.reason, g.paused], [false, 'run_budget_cap', true], 'pausa');
      const [job] = await ds.query(`select worker_status, output_summary->'pause'->>'reason' as reason from public.production_jobs where id = $1`, [runC]);
      eq([job.worker_status, job.reason], ['paused', 'run_budget_cap'], 'run pausado por el techo');
      await rejectsRe(runs.resumeRun(C.cid, OWNER, 1, runC), /run_budget_cap/, 'reanudar sin ampliar', 409);
    });

    await check('DB c6: el disyuntor sigue activo en un run autorizado por el usuario (consumo anómalo → circuit_breaker + pausa)', async () => {
      const Bk = await makeCourse('Disyuntor c6');
      await coursePolicy(Bk.cid, BIG);
      const pv = await runs.previewStart(Bk.cid, USER, 1, NCTX);
      const runB = (await runs.approveAndStart(Bk.cid, USER, 1, NCTX, pv.estimateHash)).run.id;
      const g = await budget.guardRunSpend({ runId: runB, itemRunId: null, nextCost: dec(pv.estimate.expected) * 10 + 50, authorizedBudget: null });
      eq([g.decision.allow, g.decision.reason, g.paused], [false, 'circuit_breaker', true], `disyuntor (${g.decision.detail})`);
      const [job] = await ds.query(`select worker_status, output_summary->'pause'->>'reason' as reason from public.production_jobs where id = $1`, [runB]);
      eq([job.worker_status, job.reason], ['paused', 'circuit_breaker'], 'pausado');
    });

    await check('DB runs históricos sin cambios: runPaidAuthorizedBudget = la consulta anterior a r62 en TODO run sin firma; sus filas y su autorización no cambiaron; retomarlos no escribe autorizaciones', async () => {
      for (const id of [runH1, runH2]) {
        const now = { paid: await budget.runPaidAuthorizedBudget(id), any: await budget.runAuthorizedBudget(id), rows: (await ds.query(`select count(*)::int n from public.cost_budget_authorizations where run_id = $1`, [id]))[0].n };
        eq(now, histBefore[id], `run ${id}`);
      }
      eq(histBefore[runH2].paid, null, 'el mock AUTO nunca cubrió proveedores pagados');
      const signed = new Set((await ds.query(`select a.run_id from public.cost_budget_authorizations a join public.cost_budget_authorizations s on s.id::text = substring(a.reason from 12)
                                               where a.reason like 'bound_from:%' and s.reason like 'user_authorized_within_policy:%'`)).map((x) => x.run_id));
      const all = (await ds.query(`select distinct run_id from public.cost_budget_authorizations where run_id is not null`)).map((x) => x.run_id);
      let compared = 0;
      for (const id of all) {
        if (signed.has(id)) continue;
        eq(await budget.runPaidAuthorizedBudget(id), await oldPaidAuthorized(id), `run ${id}`);
        compared++;
      }
      assert(compared >= 2, 'comparó runs sin firma');
      // Retomar un run histórico (existente) por «Autorizar y generar» no firma nada nuevo.
      const n0 = (await authRows(H1.cid)).length;
      const again = await runs.approveAndStart(H1.cid, USER, 1, NCTX, 'a'.repeat(64));
      eq([again.created, again.run.id, (await authRows(H1.cid)).length], [false, runH1, n0], 'existente: sin filas nuevas');
    });

    // ════ d12: endpoint de admin de políticas ════
    // Endpoint: la cota de cordura de un tope es USD 100.000.
    const EP = { maxCostPerRun: '1000', maxCostPerCourse: '1000', monthlyCap: '100000', ownerMonthlyCap: '100000' };
    await check('DB d12: endpoint solo SuperAdmin (guards de la clase); POST valida (400), crea versión nueva append-only con auditoría; la anterior queda intacta; noop sin cambios; GET versiones y política vigente del curso', async () => {
      const guards = Reflect.getMetadata('__guards__', FinopsAdminController) || [];
      assert(guards.includes(SuperAdminGuard), 'SuperAdminGuard en FinopsAdminController');
      const D = await makeCourse('Política por endpoint');
      await rejectsRe(admin.updateBudgetPolicy({ scope: 'course', scopeId: String(D.cid), limits: { maxCostPerRun: -3 }, reason: 'negativo no' }, ADMIN), /maxCostPerRun: decimal inválido/, 'validación', 400);
      await rejectsRe(admin.updateBudgetPolicy({ scope: 'course', scopeId: '999999', limits: EP, reason: 'curso inexistente' }, ADMIN), /no existe el curso/, 'curso', 404);
      await rejectsRe(admin.updateBudgetPolicy({ scope: 'course', scopeId: String(D.cid), limits: { maxCostPerRun: '5' }, reason: 'sin los tres topes' }, ADMIN), /necesita maxCostPerRun/, 'nueva sin topes', 400);
      const r1 = await admin.updateBudgetPolicy({ scope: 'course', scopeId: String(D.cid), limits: EP, reason: 'alta del cliente (r62)' }, ADMIN);
      eq([r1.created, r1.policy.version, r1.policy.requireHumanApprovalForRealSpend, r1.policy.legacyRequireHumanColumn], [true, 1, false, false], 'v1');
      assert(/^admin_policy_update:admin@cursia\.test · alta del cliente/.test(r1.policy.createdBy), r1.policy.createdBy);
      eq((await runs.previewStart(D.cid, USER, 1, NCTX)).approval.mode, 'user', 'v1 → autorización única');
      const r2 = await admin.updateBudgetPolicy({ scope: 'course', scopeId: String(D.cid), requireHumanApprovalForRealSpend: true, reason: 'cliente en revisión' }, ADMIN);
      eq([r2.created, r2.policy.version, r2.policy.requireHumanApprovalForRealSpend], [true, 2, true], 'v2 explícita');
      eq((await runs.previewStart(D.cid, USER, 1, NCTX)).approval.mode, 'admin', 'v2 → admin');
      const r3 = await admin.updateBudgetPolicy({ scope: 'course', scopeId: String(D.cid), requireHumanApprovalForRealSpend: true, reason: 'repetido' }, ADMIN);
      eq([r3.created, r3.policy.version], [false, 2], 'noop');
      const list = await admin.budgetPolicies('course', String(D.cid));
      eq(list.versions.map((v) => v.version), [2, 1], 'versiones');
      const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
      eq(sorted(list.versions[1].limits), sorted(EP), 'v1 intacta (append-only)');
      let mut = null;
      try { await ds.query(`update public.cost_budget_policies set limits = '{}'::jsonb where id = $1`, [r1.policy.id]); } catch (e) { mut = e; }
      assert(mut && /append-only/.test(mut.message), 'la tabla rechaza UPDATE');
      const eff = await admin.courseBudgetPolicy(D.cid);
      eq([eff.policy.version, eff.singleUserAuthorization, eff.reason], [2, false, 'policy_requires_admin_explicitly'], 'vigente');
      await admin.updateBudgetPolicy({ scope: 'course', scopeId: String(D.cid), requireHumanApprovalForRealSpend: false, reason: 'revisión terminada' }, ADMIN);
      const eff2 = await admin.courseBudgetPolicy(D.cid);
      eq([eff2.policy.version, eff2.singleUserAuthorization, eff2.caps.missing], [3, true, []], 'v3 → autorización única');
      await rejectsRe(admin.budgetPolicies('institution', '1'), /scope inválido/, 'GET scope', 400);
    });

    // ════ Review r62: IDOR, carrera, TOCTOU del bind (M1), 409 de versión, I2 (fromRun) ════
    await check('REVIEW IDOR: otra cuenta no puede previsualizar ni firmar el curso ajeno (404, sin run ni filas); la huella de un curso no sirve en otro (estimate_stale)', async () => {
      const X = await makeCourse('IDOR');
      await coursePolicy(X.cid, BIG);
      const OTHER = { id: '99999999-2222-4333-8444-555555555555', email: 'otro@cliente.test' };
      process.env.DYNAMIC_REAL_VIDEO_OWNERS = OWNER;
      await rejectsRe(runs.previewStart(X.cid, OTHER, 1, NCTX), /./, 'preview ajeno', 404);
      const pvX = await runs.previewStart(X.cid, USER, 1, NCTX);
      await rejectsRe(runs.approveAndStart(X.cid, OTHER, 1, NCTX, pvX.estimateHash), /./, 'firma ajena', 404);
      eq([await runCount(X.cid), (await authRows(X.cid)).length], [0, 0], 'sin run ni filas');
      const Y = await makeCourse('Replay');
      await coursePolicy(Y.cid, BIG);
      await rejectsRe(runs.approveAndStart(Y.cid, USER, 1, NCTX, pvX.estimateHash), /estimate_stale/, 'replay a otro curso', 409);
      eq(await runCount(Y.cid), 0, 'sin run Y');
    });

    await check('REVIEW M7 carrera: 8 «Autorizar y generar» en paralelo con un mes para ~2,5 máximos → arrancan los que entran (la firma no queda «vieja» por el gasto de los otros), el resto 409 budget_blocked con el límite mensual; nunca estimate_stale; el comprometido no supera el tope', async () => {
      const N = 8;
      const Ks = [];
      for (let i = 0; i < N; i++) Ks.push(await makeCourse('Carrera ' + i));
      await coursePolicy(Ks[0].cid, BIG);
      const max = dec((await runs.previewStart(Ks[0].cid, USER, 1, NCTX)).estimate.max);
      const m0 = await budget.monthCommitted();
      const cap = (dec(m0.total) + max * 2.5).toFixed(6);
      for (const [i, K] of Ks.entries()) {
        await ds.query(`insert into public.cost_budget_policies (scope, scope_id, version, limits, on_exceed) values ('course', $1, $2, $3::jsonb, 'ADMIN_APPROVAL')`,
          [String(K.cid), i === 0 ? 2 : 1, JSON.stringify({ maxCostPerRun: '1000', maxCostPerCourse: '1000', monthlyCap: cap, ownerMonthlyCap: '1000000000' })]);
      }
      const pvs = [];
      for (const K of Ks) pvs.push(await runs.previewStart(K.cid, USER, 1, NCTX));
      assert(pvs.every((p) => p.approval.mode === 'user' && p.approval.withinPolicy), 'todos firmables antes de la carrera');
      const res = await Promise.allSettled(Ks.map((K, i) => runs.approveAndStart(K.cid, USER, 1, NCTX, pvs[i].estimateHash)));
      const ok = res.filter((r) => r.status === 'fulfilled' && r.value.created);
      const codes = res.filter((r) => r.status === 'rejected').map((r) => (r.reason.getResponse && r.reason.getResponse().code) || r.reason.message.slice(0, 60));
      assert(ok.length === 2, `creados ${ok.length} (${codes.join(' | ')})`);
      assert(codes.length === N - 2 && codes.every((c) => c === 'budget_blocked'), `rechazos: ${codes.join(' | ')}`);
      const blocked = res.find((r) => r.status === 'rejected').reason.getResponse();
      assert(blocked.blockedBy.some((b) => b.limit === 'monthlyCap'), JSON.stringify(blocked.blockedBy));
      assert(dec((await budget.monthCommitted()).total) <= dec(cap) + 1e-9, 'comprometido ≤ tope');
    });

    await check('REVIEW M1: la política cambia ENTRE el preview y la tx (flag explícito de admin) → el bind relee la política en la tx y rechaza la firma (estimate_stale), sin run ni filas', async () => {
      const T = await makeCourse('TOCTOU');
      await coursePolicy(T.cid, BIG);
      const pv = await runs.previewStart(T.cid, USER, 1, NCTX);
      const orig = runs.normalPlan;
      let once = true;
      runs.normalPlan = async function (runner, ...rest) {
        if (once && runner !== ds) {
          once = false;
          await ds.query(`insert into public.cost_budget_policies (scope, scope_id, version, limits, on_exceed) values ('course', $1, 2, $2::jsonb, 'ADMIN_APPROVAL')`,
            [String(T.cid), JSON.stringify({ ...BIG, requireHumanApprovalForRealSpend: true })]);
        }
        return orig.call(this, runner, ...rest);
      };
      try {
        await rejectsRe(runs.approveAndStart(T.cid, USER, 1, NCTX, pv.estimateHash), /estimate_stale.*(versión nueva|requiere un administrador)/, 'TOCTOU', 409);
      } finally { runs.normalPlan = orig; }
      eq([await runCount(T.cid), (await authRows(T.cid)).length], [0, 0], 'sin run ni filas');
    });

    await check('REVIEW d12: 409 policy_version_conflict ante una carrera de versiones (índice único); I1: un tope válido nunca deja la política ilegible', async () => {
      const dup = new FinopsAdminController(ledger, { updatePolicy: async () => { throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }); } });
      await rejectsRe(dup.updateBudgetPolicy({ scope: 'global', limits: BIG, reason: 'carrera' }, ADMIN), /policy_version_conflict/, 'carrera', 409);
      const Z = await makeCourse('Poison');
      await rejectsRe(admin.updateBudgetPolicy({ scope: 'course', scopeId: String(Z.cid), limits: { maxCostPerRun: 1e-20, maxCostPerCourse: '10', monthlyCap: '10' }, reason: 'notación científica' }, ADMIN), /decimal inválido/, '1e-20', 400);
      const r = await admin.updateBudgetPolicy({ scope: 'course', scopeId: String(Z.cid), limits: { maxCostPerRun: 0.5, maxCostPerCourse: '1000.50', monthlyCap: '99999.9900', ownerMonthlyCap: '500' }, reason: 'decimales válidos' }, ADMIN);
      eq([r.policy.limits.maxCostPerRun, r.policy.limits.maxCostPerCourse, r.policy.limits.monthlyCap], ['0.5', '1000.5', '99999.99'], 'normalizado');
      const pv = await runs.previewStart(Z.cid, USER, 1, NCTX);
      assert(pv.decision && pv.estimate, 'la política sigue legible (sin 503)');
    });

    await check('REVIEW I2: run B desde fromRun dentro de la política → preview con huella y monto (mode user); POST {fromRun} sin firma → 409 user_authorization_required; {fromRun, estimateHash} de un NO admin → run B con la firma AUTO_WITHIN_POLICY (planSha en el estimado) que cubre proveedores pagados; huella vieja → estimate_stale', async () => {
      const Fr = await makeCourse('Run B firmado');
      await coursePolicy(Fr.cid, BIG);
      const pvA = await runs.previewStart(Fr.cid, USER, 1, NCTX);
      const runAid = (await runs.approveAndStart(Fr.cid, USER, 1, NCTX, pvA.estimateHash)).run.id;
      await ds.query(`update public.production_jobs set status = 'completed', worker_status = 'completed', finished_at = now() where id = $1`, [runAid]);
      // Blueprint 2: un capítulo NUEVO (presentación + audiolibro nuevos = Gamma/TTS reales) y C2 renombrado.
      const [m1] = await ds.query(`select id from public.course_modules where course_id = $1`, [Fr.cid]);
      const chs = await ds.query(`select id, position, title, video_enabled, activity_enabled from public.course_chapters where course_id = $1 order by position`, [Fr.cid]);
      const c3 = crypto.randomUUID();
      const s2 = snap.buildBlueprintSnapshotV2({ id: Fr.cid, title: 'Run B firmado', finalExam: true, activityEngine: 'h5p' },
        [{ id: m1.id, position: 0, title: 'M1', objective: null, exam_enabled: true }],
        [...chs.map((c) => ({ id: c.id, module_id: m1.id, position: c.position, title: c.position === 1 ? 'C2 revisado' : c.title, objective: null, video_enabled: c.video_enabled, activity_enabled: c.activity_enabled })),
          { id: c3, module_id: m1.id, position: 2, title: 'C3', objective: null, video_enabled: false, activity_enabled: false }]);
      await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, video_enabled, activity_enabled) values ($1, $2, $3, 2, 'C3', false, false)`, [c3, Fr.cid, m1.id]);
      await ds.query(`insert into public.course_blueprints (course_id, blueprint_number, schema_version, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
                      values ($1, 2, 2, $2::jsonb, $3, 1, 1, 3)`, [Fr.cid, snap.canonicalJsonV2(s2), snap.snapshotSha256V2(s2)]);
      await manifests.getOrCreate(Fr.cid, OWNER, 2);
      const pv = await runs.previewFromRun(Fr.cid, USER, 2, runAid);
      eq([pv.existingRun, pv.decision, pv.approval.mode, pv.approval.userAuthorizationRequired, pv.approval.withinPolicy], [null, 'AUTO_WITHIN_POLICY', 'user', true, true], 'preview del run B');
      assert(/^[0-9a-f]{64}$/.test(pv.estimateHash) && dec(pv.approval.amount) >= dec(pv.estimate.expected) && pv.planSha256, 'huella + monto + planSha');
      assert(pv.paidRealProviders.length > 0, 'gasto pagado nuevo');
      await rejectsRe(runs.startRun(Fr.cid, OWNER, 2, { fromRun: runAid }), /user_authorization_required/, 'sin firma', 409);
      await rejectsRe(runs.startRun(Fr.cid, OWNER, 2, { fromRun: runAid, estimateHash: 'f'.repeat(64) }, { signer: USER }), /estimate_stale/, 'huella vieja', 409);
      const res = await runs.startRun(Fr.cid, OWNER, 2, { fromRun: runAid, estimateHash: pv.estimateHash }, { signer: USER });
      assert(res.created && res.invalidation && res.invalidation.fromRunId === runAid, 'run B creado');
      const rows = await ds.query(`select a.id, a.run_id, a.decision, a.approved_by, a.reason, a.authorized_budget::text b, e.invalidation_plan_sha as sha
                                     from public.cost_budget_authorizations a left join public.cost_estimates e on e.id = a.estimate_id
                                    where a.course_id = $1 and (a.run_id = $2 or (a.run_id is null and a.reason = $3)) order by a.created_at, (a.run_id is not null)`,
        [Fr.cid, res.run.id, `user_authorized_within_policy:${pv.estimateHash}`]);
      eq(rows.map((x) => [x.decision, x.run_id === null, x.approved_by]), [['AUTO_WITHIN_POLICY', true, 'docente@cliente.test'], ['AUTO_WITHIN_POLICY', false, 'docente@cliente.test']], 'firma + vinculada');
      eq(rows[1].reason, `bound_from:${rows[0].id}`, 'vinculada');
      eq(dec(await budget.runPaidAuthorizedBudget(res.run.id)), dec(pv.approval.amount), 'cubre proveedores pagados del run B');
      const again = await runs.startRun(Fr.cid, OWNER, 2, { fromRun: runAid, estimateHash: pv.estimateHash }, { signer: USER });
      eq([again.created, again.run.id], [false, res.run.id], 'idempotente (mismo B, sin firmas nuevas)');
      eq((await runs.previewFromRun(Fr.cid, USER, 2, runAid)).existingRun.id, res.run.id, 'preview con B existente');
    });

  } finally {
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    console.log('PG16 descartable destruido');
  }
}

(async () => {
  await pureChecks();
  if (PURE_ONLY) {
    console.log('ℹ️  --pure-only: parte DB (PG16 desechable) NO ejecutada');
  } else {
    try {
      await dbChecks();
    } catch (err) {
      failures++;
      console.error(`❌ setup de la parte DB falló: ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})();
