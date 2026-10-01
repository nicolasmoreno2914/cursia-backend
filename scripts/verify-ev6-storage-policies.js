#!/usr/bin/env node
/* eslint-disable */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// EV6 DoD follow-up (R6) — verificación de SOLO LECTURA de las políticas VIVAS de Storage del bucket de
// artifacts. La garantía «un paquete QA / degradado (`qa-internal/<owner>/…`) solo lo firma el backend»
// descansa en que NINGUNA política de un rol que no sea de servicio pueda coincidir con `qa-internal/`
// (las del repo exigen `foldername(name)[1] = auth.uid()`, y `qa-internal` nunca es un uuid) y en que el
// bucket NO sea público. Las políticas creadas desde el dashboard no están en el repo: esto las lee de la
// base real (pg_policies + storage.buckets).
//
// Falla (exit 1) si:
//   - el bucket no existe o es `public = true`;
//   - storage.objects no tiene ROW LEVEL SECURITY;
//   - alguna política PERMISIVA de un rol que no es de servicio (anon, authenticated, public, …) que
//     pueda aplicar al bucket (lo nombra o no restringe el bucket) no exige la carpeta propia
//     (`(storage.foldername(name))[1] = auth.uid()`) en TODAS sus expresiones, o usa OR (no se puede
//     probar que la restricción aplique siempre → se trata como que puede coincidir: falla cerrada).
//
// Nunca escribe: todo corre dentro de `BEGIN … READ ONLY` y solo emite SELECT. Solo STAGING:
// MIGRATION_ENV=staging obligatorio y nunca contra el proyecto de producción (lo cablea deploy-staging.yml;
// nunca el workflow de producción). Conexión: DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME, DB_SSL (las
// mismas variables que los demás verify-*.js). Bucket: STORAGE_ARTIFACTS_BUCKET (default cursia-artifacts).
//
// Usage: MIGRATION_ENV=staging node scripts/verify-ev6-storage-policies.js

const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';
const DEFAULT_BUCKET = 'cursia-artifacts';
/** Roles de servicio / internos de Supabase (ignoran RLS o no son de cliente). */
const SERVICE_ROLES = ['service_role', 'postgres', 'supabase_admin', 'supabase_storage_admin'];

function assertExplicitStagingIntent() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error(
      '❌ MIGRATION_ENV no es "staging" — esta verificación es solo para staging.\n' +
      '   deploy-staging.yml lo setea automáticamente; a mano:\n' +
      '   MIGRATION_ENV=staging node scripts/verify-ev6-storage-policies.js',
    );
    process.exit(1);
  }
}

function extractSupabaseProjectRef() {
  const host = String(process.env.DB_HOST || '');
  const user = String(process.env.DB_USER || '');
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (m) return m[1].toLowerCase();
  m = user.match(/^postgres\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  return null;
}

function assertNotProductionProject() {
  const ref = extractSupabaseProjectRef();
  if (ref === KNOWN_PRODUCTION_SUPABASE_REF) {
    console.error('❌ La conexión apunta al proyecto de PRODUCCIÓN (' + ref + '). Abortando: esta verificación es solo de staging.');
    process.exit(1);
  }
}

/** `roles` de pg_policies llega como array (pg) o como literal `{a,b}`. */
function rolesOf(v) {
  if (Array.isArray(v)) return v.map(String);
  return String(v || '').replace(/^\{|\}$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

const OWN_FOLDER_RE = /\(\s*storage\.foldername\(\s*name\s*\)\s*\)\s*\[\s*1\s*\]\s*=\s*\(*\s*(?:select\s+)?auth\.uid\(\)/i;
const OR_RE = /\bor\b/i;

/** Buckets nombrados en una expresión (`bucket_id = 'x'::text`). */
function bucketsNamed(expr) {
  const out = [];
  const re = /bucket_id\s*=\s*'([^']*)'/gi;
  let m;
  while ((m = re.exec(expr))) out.push(m[1]);
  return out;
}

/**
 * Veredicto de UNA política (pura, exportada para el check). `null` = no puede coincidir con
 * `qa-internal/` para un rol de cliente; string = por qué podría.
 */
function policyRisk(p, bucket = DEFAULT_BUCKET) {
  const roles = rolesOf(p.roles);
  const clientRoles = roles.filter((r) => !SERVICE_ROLES.includes(r));
  if (!clientRoles.length) return null;
  if (String(p.permissive || 'PERMISSIVE').toUpperCase() === 'RESTRICTIVE') return null; // nunca concede acceso
  const cmd = String(p.cmd || 'ALL').toUpperCase();
  const exprs = [];
  if (cmd !== 'INSERT') exprs.push(p.qual == null ? null : String(p.qual));
  if (cmd === 'INSERT' || cmd === 'UPDATE' || cmd === 'ALL') {
    const wc = p.with_check == null ? (cmd === 'ALL' ? p.qual : null) : p.with_check;
    exprs.push(wc == null ? null : String(wc));
  }
  for (const e of exprs) {
    if (e == null || !e.trim()) return `sin expresión (${cmd}) para ${clientRoles.join(',')}: coincide con cualquier objeto`;
    const named = bucketsNamed(e);
    // Una expresión sin OR que solo nombra OTROS buckets no aplica a este.
    if (!OR_RE.test(e) && named.length && !named.includes(bucket)) continue;
    if (OR_RE.test(e)) return `usa OR (${cmd}) para ${clientRoles.join(',')}: no se puede probar que exija la carpeta propia`;
    if (!OWN_FOLDER_RE.test(e)) return `no exige la carpeta propia (foldername(name)[1] = auth.uid()) en ${cmd} para ${clientRoles.join(',')}`;
  }
  return null;
}

/** Verificación (solo lectura) sobre una conexión ya abierta. Exportada para el check local. */
async function verifyEv6StoragePolicies(client, bucket = DEFAULT_BUCKET) {
  const failures = [];
  const ok = [];
  await client.query('begin transaction isolation level repeatable read read only');
  try {
    const b = (await client.query(`select id, public from storage.buckets where id = $1`, [bucket])).rows[0];
    if (!b) failures.push(`El bucket ${bucket} no existe en storage.buckets.`);
    else if (b.public === true) failures.push(`El bucket ${bucket} es PÚBLICO (public = true): cualquiera puede leer qa-internal/ por URL pública.`);
    else ok.push(`bucket ${bucket}: public = false`);
    const rel = (await client.query(
      `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'storage' and c.relname = 'objects'`,
    )).rows[0];
    if (!rel) failures.push('No existe storage.objects.');
    else if (!rel.relrowsecurity) failures.push('storage.objects no tiene ROW LEVEL SECURITY.');
    const policies = (await client.query(
      `select policyname, permissive, roles, cmd, qual, with_check
         from pg_policies where schemaname = 'storage' and tablename = 'objects'
        order by policyname`,
    )).rows;
    for (const p of policies) {
      const risk = policyRisk(p, bucket);
      if (risk) failures.push(`Política ${p.policyname}: ${risk}.`);
      else ok.push(`política ${p.policyname} (${p.cmd}, ${rolesOf(p.roles).join(',')}): no coincide con qa-internal/`);
    }
    return { failures, ok, policies: policies.length };
  } finally {
    await client.query('rollback');
  }
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  assertExplicitStagingIntent();
  assertNotProductionProject();
  const bucket = String(process.env.STORAGE_ARTIFACTS_BUCKET || DEFAULT_BUCKET);
  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
    application_name: 'cursia-verify-ev6-storage-policies (read-only)',
  });
  await client.connect();
  try {
    const r = await verifyEv6StoragePolicies(client, bucket);
    for (const o of r.ok) console.log('  ✓ ' + o);
    if (r.failures.length) {
      for (const f of r.failures) console.error('❌ ' + f);
      console.error(`❌ Storage: ${r.failures.length} problema(s) — un paquete QA (qa-internal/) podría ser legible fuera del backend.`);
      process.exitCode = 1;
    } else {
      console.log(`✅ Storage verificado: ${r.policies} política(s) en storage.objects, ninguna coincide con qa-internal/ para un rol de cliente; bucket ${bucket} privado.`);
    }
  } finally {
    await client.end();
  }
}

module.exports = { verifyEv6StoragePolicies, policyRisk, SERVICE_ROLES };

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error inesperado:', err.message);
    process.exitCode = 1;
  });
}
