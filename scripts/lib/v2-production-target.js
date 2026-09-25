'use strict';

// ══════════════════════════════════════════════════════════════════════════
// v2-production-target.js — guardarraíl POSITIVO de producción para las
// herramientas de Fase 9 (G6): scripts/prod/migrate-v2-production.js y el
// modo `production-readonly` de los verify-*/audit-* de V2.
//
// Este módulo NO cambia el comportamiento por defecto de ningún script de
// staging: los verify/audit solo entran acá si V2_VERIFY_MODE vale
// exactamente "production-readonly"; si no, siguen corriendo sus propios
// assertExplicitStagingIntent() + assertNotProductionProject() de siempre.
// Los migrate-*.js de staging NO usan este módulo.
//
// Reglas (todas se evalúan ANTES de abrir cualquier conexión):
//   1. MIGRATION_ENV === 'production' (intención explícita).
//   2. Ref de proyecto de Supabase parseado de DB_HOST ("db.<ref>.supabase.co")
//      y/o DB_USER (pooler "postgres.<ref>"); si ambos dan ref y difieren → NO.
//   3. Ref == staging conocido (ljdtmkwuhkvtmlhugjrv) → NO (entorno equivocado).
//   4. Ref != producción conocido (hriwbakbuypaiovvvkqh) → NO (proyecto
//      desconocido; si producción cambiara de proyecto, se edita la constante
//      en un PR revisado — nunca por env).
//   5. CONFIRM_PRODUCTION_REF === ref (el operador escribe el ref a mano).
//   6. DB_SSL === 'true' (Supabase exige TLS).
//   7. Solo para mutar (kind 'apply'): CONFIRM_BACKUP_TAKEN === 'yes'.
// Y DESPUÉS de conectar (assertServerIdentity): el servidor tiene que ser un
// Postgres de Supabase (existe el rol supabase_admin).
//
// ── Override SOLO para tests (documentado en docs/v2-production-migrations.md)
// Permite correr la herramienta contra un Postgres 16 local desechable con un
// ref "falso tipo producción". Se activa solo si se cumplen TODAS:
//   a) NODE_ENV === 'test';
//   b) el flag explícito: CLI --test-allow-local-target en el runner (que lo
//      propaga a los hijos como V2_TEST_ALLOW_LOCAL_TARGET=1), o esa env var
//      al invocar un verify/audit directamente;
//   c) V2_TEST_FAKE_PROJECT_REF con forma de ref ([a-z0-9]{6,40});
//   d) DB_HOST es loopback (127.0.0.1 / ::1 / localhost) — producción nunca
//      lo es;
//   e) ya conectado: el servidor NO tiene el rol supabase_admin (o sea, NO es
//      un Postgres de Supabase, ni siquiera producción tunelada a localhost).
// Con el override: la regla 4 y la 6 no aplican; las reglas 1, 3, 5 y 7 SÍ
// aplican sobre el ref falso (un ref falso == staging también se rechaza).
// ══════════════════════════════════════════════════════════════════════════

const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';
const KNOWN_STAGING_SUPABASE_REF = 'ljdtmkwuhkvtmlhugjrv';
const REF_RE = /^[a-z0-9]{6,40}$/;
const fs = require('fs');
const path = require('path');

// I1 (fix wave): lo ÚNICO que un --env-file puede aportar son claves de
// conexión. MIGRATION_ENV, CONFIRM_*, NODE_ENV, V2_TEST_*, V2_VERIFY_MODE,
// V2_HEALTH_*, V2_DB_SSL_CA y cualquier otra perilla de seguridad tienen que
// venir del entorno real del proceso del operador (o de la CLI).
const ENV_FILE_ALLOWED_KEYS = new Set(['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASS', 'DB_NAME', 'DB_SSL']);

class TargetRefusal extends Error {
  constructor(reasons) {
    super('Objetivo rechazado:\n  - ' + reasons.join('\n  - '));
    this.name = 'TargetRefusal';
    this.reasons = reasons;
  }
}

function parseProjectRef(env) {
  const host = String(env.DB_HOST || '');
  const user = String(env.DB_USER || '');
  const hostM = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  // Pooler de Supavisor: "postgres.<ref>" (histórico, cualquier largo) o un
  // rol de mínimo privilegio "<rol>.<ref de 20>" (M5, p. ej. health_ro.<ref>).
  const userM = user.match(/^postgres\.([a-z0-9]+)$/i) || user.match(/^[a-z_][a-z0-9_]*\.([a-z0-9]{20})$/i);
  const fromHost = hostM ? hostM[1].toLowerCase() : null;
  const fromUser = userM ? userM[1].toLowerCase() : null;
  if (fromHost && fromUser && fromHost !== fromUser) {
    return { ref: null, source: 'conflict', conflict: { fromHost, fromUser } };
  }
  if (fromHost) return { ref: fromHost, source: 'DB_HOST', conflict: null };
  if (fromUser) return { ref: fromUser, source: 'DB_USER', conflict: null };
  return { ref: null, source: null, conflict: null };
}

function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/**
 * Evalúa el override de tests. Devuelve {active:false} salvo que se cumplan
 * a)–d) (la e) se verifica después de conectar, en assertServerIdentity).
 */
function resolveTestOverride(env, { testFlag = false, envFlagAllowed = true } = {}) {
  // El runner pasa envFlagAllowed:false → para él solo vale el flag de CLI.
  const flag = testFlag === true || (envFlagAllowed && env.V2_TEST_ALLOW_LOCAL_TARGET === '1');
  const fakeRef = String(env.V2_TEST_FAKE_PROJECT_REF || '').toLowerCase();
  const requested = flag || !!env.V2_TEST_FAKE_PROJECT_REF;
  const missing = [];
  if (env.NODE_ENV !== 'test') missing.push('NODE_ENV=test');
  if (!flag) missing.push('--test-allow-local-target (o V2_TEST_ALLOW_LOCAL_TARGET=1)');
  if (!REF_RE.test(fakeRef)) missing.push('V2_TEST_FAKE_PROJECT_REF=<[a-z0-9]{6,40}>');
  if (!isLoopbackHost(env.DB_HOST)) missing.push('DB_HOST loopback (127.0.0.1/::1/localhost)');
  return { active: missing.length === 0, requested, fakeRef: missing.length === 0 ? fakeRef : null, missing };
}

/**
 * Valida el objetivo SIN conectar. kind: 'apply' | 'readonly'.
 * Devuelve { ref, source, testMode }. Lanza TargetRefusal con TODAS las
 * razones (no solo la primera) para que el operador las corrija de una vez.
 */
function assertProductionTarget(env, { kind, testFlag = false, envFlagAllowed = true } = {}) {
  if (kind !== 'apply' && kind !== 'readonly') throw new Error('kind inválido: ' + kind);
  const reasons = [];
  const test = resolveTestOverride(env, { testFlag, envFlagAllowed });
  if ((test.requested || env.V2_TEST_ALLOW_LOCAL_TARGET === '1') && !test.active) {
    reasons.push('override de tests pedido pero incompleto — falta: ' + test.missing.join(', '));
  }

  if (env.MIGRATION_ENV !== 'production') {
    reasons.push('MIGRATION_ENV debe ser exactamente "production" (valor actual: ' + JSON.stringify(env.MIGRATION_ENV || null) + ')');
  }

  let ref;
  let source;
  if (test.active) {
    ref = test.fakeRef;
    source = 'V2_TEST_FAKE_PROJECT_REF (override de tests)';
  } else {
    const parsed = parseProjectRef(env);
    if (parsed.conflict) {
      reasons.push(`DB_HOST (${parsed.conflict.fromHost}) y DB_USER (${parsed.conflict.fromUser}) apuntan a proyectos distintos`);
    } else if (!parsed.ref) {
      reasons.push('no se pudo determinar el ref de Supabase desde DB_HOST ("db.<ref>.supabase.co") ni DB_USER (pooler "postgres.<ref>")');
    }
    ref = parsed.ref;
    source = parsed.source;
  }

  if (ref && ref === KNOWN_STAGING_SUPABASE_REF) {
    reasons.push(`el ref ${ref} es el de STAGING — entorno equivocado (para staging usá deploy-staging.yml / los migrate-*.js con MIGRATION_ENV=staging)`);
  }
  if (ref && !test.active && ref !== KNOWN_PRODUCTION_SUPABASE_REF) {
    reasons.push(`el ref ${ref} no es el de producción conocido (${KNOWN_PRODUCTION_SUPABASE_REF}); si producción cambió de proyecto, actualizá la constante en un PR revisado`);
  }
  const confirm = String(env.CONFIRM_PRODUCTION_REF || '').trim().toLowerCase();
  if (!confirm) {
    reasons.push('falta CONFIRM_PRODUCTION_REF (escribí a mano el ref del proyecto objetivo)');
  } else if (ref && confirm !== ref) {
    reasons.push(`CONFIRM_PRODUCTION_REF (${confirm}) no coincide con el ref de la conexión (${ref})`);
  }
  if (!test.active && String(env.DB_SSL || '').toLowerCase() !== 'true') {
    reasons.push('DB_SSL debe ser "true" (Supabase exige TLS)');
  }
  if (env.V2_DB_SSL_CA && !fs.existsSync(env.V2_DB_SSL_CA)) {
    reasons.push(`V2_DB_SSL_CA apunta a un archivo inexistente (${env.V2_DB_SSL_CA})`);
  }
  if (kind === 'apply' && env.CONFIRM_BACKUP_TAKEN !== 'yes') {
    reasons.push('falta CONFIRM_BACKUP_TAKEN=yes (el owner confirmó backup/PITR verificado — ver docs/v2-production-migrations.md §Precondiciones)');
  }

  if (reasons.length > 0) throw new TargetRefusal(reasons);
  return { ref, source, testMode: test.active };
}

/** Después de conectar: el servidor tiene que ser (o NO ser, en tests) Supabase. */
async function assertServerIdentity(client, { testMode }) {
  const { rows } = await client.query(
    `select exists (select 1 from pg_roles where rolname = 'supabase_admin') as is_supabase`,
  );
  const isSupabase = rows[0].is_supabase === true;
  if (testMode && isSupabase) {
    throw new TargetRefusal([
      'override de tests activo pero el servidor tiene el rol supabase_admin (es un Postgres de Supabase) — el override solo vale contra un Postgres local desechable',
    ]);
  }
  if (!testMode && !isSupabase) {
    throw new TargetRefusal(['el servidor no tiene el rol supabase_admin — no parece un Postgres de Supabase']);
  }
}

/**
 * M3 (fix wave): solo lectura POR TRANSACCIÓN, no por sesión. Un
 * `SET SESSION CHARACTERISTICS` no sobrevive (y hasta podría filtrarse) detrás
 * del pooler de Supavisor en modo transacción; un `BEGIN TRANSACTION READ
 * ONLY` fija el backend durante toda la transacción y cualquier escritura
 * falla con SQLSTATE 25006. Cerrar la conexión sin COMMIT la revierte.
 */
async function beginReadOnlyTransaction(client, { statementTimeout = '120s' } = {}) {
  await client.query('begin transaction read only');
  await client.query(`set local statement_timeout = '${statementTimeout}'`);
  const { rows } = await client.query('show transaction_read_only');
  if (rows[0].transaction_read_only !== 'on') {
    throw new Error('no se pudo abrir una transacción de solo lectura');
  }
}

// Control de transacción/sesión que rompería la transacción READ ONLY única.
const FORBIDDEN_IN_READONLY = /^\s*(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction|set\s+session|set\s+transaction|reset|discard)\b/i;

/**
 * Tras beginReadOnlyTransaction: envuelve client.query para que NADA pueda
 * cerrar/cambiar esa transacción (defensa en profundidad: las sondas con
 * escritura revertida ya están desactivadas por código en production-readonly).
 */
function lockReadOnlyClient(client) {
  const original = client.query.bind(client);
  client.query = function guardedQuery(config, ...rest) {
    const text = typeof config === 'string' ? config : config && config.text;
    if (typeof text === 'string' && FORBIDDEN_IN_READONLY.test(text)) {
      const err = new Error(`production-readonly: sentencia de control de transacción/sesión rechazada: ${text.trim().split(/\s+/).slice(0, 3).join(' ')}`);
      if (typeof rest[rest.length - 1] === 'function') return rest[rest.length - 1](err);
      return Promise.reject(err);
    }
    return original(config, ...rest);
  };
  return client;
}

/**
 * M6 (fix wave): con V2_DB_SSL_CA (ruta a un PEM, p. ej. el CA de Supabase)
 * se verifican certificados (rejectUnauthorized: true). Sin CA se mantiene el
 * comportamiento de los scripts existentes (rejectUnauthorized: false) y
 * tlsWarning() devuelve un aviso explícito para imprimir antes de conectar.
 */
function pgClientConfigFromEnv(env) {
  let ssl = false;
  if (String(env.DB_SSL || '').toLowerCase() === 'true') {
    ssl = env.V2_DB_SSL_CA
      ? { ca: fs.readFileSync(env.V2_DB_SSL_CA, 'utf8'), rejectUnauthorized: true }
      : { rejectUnauthorized: false };
  }
  return {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
    ssl,
    connectionTimeoutMillis: 15000,
    application_name: 'cursia-v2-production-tooling',
  };
}

function tlsWarning(env) {
  if (String(env.DB_SSL || '').toLowerCase() === 'true' && !env.V2_DB_SSL_CA) {
    return '⚠️  TLS sin verificación de certificado (rejectUnauthorized=false): definí V2_DB_SSL_CA=<ruta al CA de Supabase> para verificarlo.';
  }
  return null;
}

/**
 * I1 (fix wave): carga un --env-file aceptando SOLO claves de conexión DB_*.
 * El entorno del proceso gana. Devuelve las claves cargadas e ignoradas
 * (solo nombres, nunca valores).
 */
function loadDbEnvFile(envPath, env = process.env) {
  const abs = path.resolve(envPath);
  if (!fs.existsSync(abs)) throw new Error(`--env-file no existe: ${abs}`);
  const loaded = [];
  const ignored = [];
  for (const rawLine of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!ENV_FILE_ALLOWED_KEYS.has(key)) { ignored.push(key); continue; }
    if (!(key in env)) { env[key] = value; loaded.push(key); }
  }
  return { abs, loaded, ignored };
}

function describeIgnoredEnvFileKeys(ignored) {
  if (!ignored.length) return null;
  return `⚠️  --env-file: claves ignoradas (solo se aceptan ${[...ENV_FILE_ALLOWED_KEYS].join(', ')}; ` +
    `las confirmaciones y perillas de seguridad deben venir del entorno real del operador): ${[...new Set(ignored)].join(', ')}`;
}

/** M4 (fix wave): quita JWT, tokens de query, URLs y emails de un texto libre. */
function redactSensitive(text) {
  if (text === null || text === undefined) return text;
  return String(text)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer [redacted]')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b(token|sig|signature|apikey|api_key|key|access_token|refresh_token|secret|password|pwd)=[^\s&"']+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
}

// ── Hooks para los verify-*/audit-* existentes ─────────────────────────────

function isProductionReadonlyRequested(env = process.env) {
  return env.V2_VERIFY_MODE === 'production-readonly';
}

/**
 * Llamado por un verify/audit en lugar de sus guards de staging cuando
 * V2_VERIFY_MODE=production-readonly. Sale con código 1 si el objetivo no
 * pasa las reglas (nunca conecta en ese caso).
 */
function assertProductionReadonlyTargetOrExit(env = process.env) {
  try {
    const target = assertProductionTarget(env, { kind: 'readonly' });
    console.log(
      `🔒 Modo production-readonly — ref ${target.ref}${target.testMode ? ' (OVERRIDE DE TESTS, Postgres local)' : ''}; ` +
      'sesión READ ONLY, se omiten las sondas con escritura revertida.',
    );
    return target;
  } catch (err) {
    console.error('❌ ' + err.message);
    process.exit(1);
  }
}

/**
 * Tras client.connect(): identidad del servidor + UNA transacción READ ONLY que
 * dura hasta client.end() (sin COMMIT → se revierte) + cliente bloqueado
 * contra control de transacción/sesión.
 */
async function enterProductionReadonlySession(client, target) {
  await assertServerIdentity(client, { testMode: target.testMode });
  await beginReadOnlyTransaction(client);
  lockReadOnlyClient(client);
}

function logSkippedProbe(label) {
  console.log(`⏭️  [production-readonly] sonda omitida (escribe dentro de una transacción revertida): ${label}`);
}

module.exports = {
  KNOWN_PRODUCTION_SUPABASE_REF,
  KNOWN_STAGING_SUPABASE_REF,
  TargetRefusal,
  parseProjectRef,
  isLoopbackHost,
  resolveTestOverride,
  assertProductionTarget,
  assertServerIdentity,
  beginReadOnlyTransaction,
  lockReadOnlyClient,
  pgClientConfigFromEnv,
  tlsWarning,
  loadDbEnvFile,
  describeIgnoredEnvFileKeys,
  redactSensitive,
  ENV_FILE_ALLOWED_KEYS,
  isProductionReadonlyRequested,
  assertProductionReadonlyTargetOrExit,
  enterProductionReadonlySession,
  logSkippedProbe,
};
