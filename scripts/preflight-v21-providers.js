#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — preflight de proveedores de STAGING (SOLO LECTURA).
//
// Informa, sin imprimir NUNCA un valor secreto:
//   1. readiness de cada proveedor real (Gamma / OpenAI TTS + Anthropic server-side / Videogen),
//      con la MISMA función que usa startRun (providerReadinessMissing): solo nombres de variables;
//   2. DYNAMIC_PROVIDER_WORKER_ENABLED (debe seguir en false hasta aprobar la calibración);
//   3. FinOps: FINOPS_INGEST_TOKEN presente (sí/no) + catálogo de precios (filas y cuántas verificadas
//      por proveedor) + políticas de presupuesto y autorizaciones (conteos) — consultas SELECT;
//   4. (opcional, PREFLIGHT_GAMMA_THEMES=1) el listado de temas de Gamma (GET /themes: no genera nada,
//      no consume créditos) para elegir GAMMA_THEME_V21_LIGHT_DEFAULT / _DARK_DEFAULT.
//
// Nunca falla el deploy por lo que falte (es informativo): solo sale ≠ 0 si detecta el ref de
// PRODUCCIÓN (este preflight es exclusivo de staging).
//
// Uso (en el directorio de staging, después del build): MIGRATION_ENV=staging node scripts/preflight-v21-providers.js
const fs = require('fs');
const path = require('path');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const KNOWN_PRODUCTION_SUPABASE_REF = 'hriwbakbuypaiovvvkqh';

function dbProjectRef(env) {
  const host = String(env.DB_HOST || '');
  const user = String(env.DB_USER || '');
  let m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (m) return m[1].toLowerCase();
  m = user.match(/^postgres\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
}

const present = (env, k) => typeof env[k] === 'string' && env[k].trim() !== '';

async function main() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error('❌ MIGRATION_ENV no es "staging" — este preflight es exclusivo de staging.');
    process.exit(1);
  }
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  const env = process.env;
  const ref = dbProjectRef(env);
  if (ref === KNOWN_PRODUCTION_SUPABASE_REF || String(env.SUPABASE_URL || '').includes(KNOWN_PRODUCTION_SUPABASE_REF)) {
    console.error('❌ La configuración apunta al proyecto de PRODUCCIÓN — preflight abortado (solo staging).');
    process.exit(1);
  }

  const R = require(path.resolve('dist/modules/dynamic-generation/provider-readiness.js'));

  console.log('── Proveedores reales (misma verificación que startRun; solo nombres) ──');
  const missing = R.providerReadinessMissing(
    { providerModes: { presentation: 'real', audio: 'real' }, videoMode: 'real', videoCount: 1 },
    env,
  );
  const byFam = { presentation: [], audio: [], video: [] };
  for (const m of missing) (byFam[m.split(':')[0]] || (byFam.other = byFam.other || [])).push(m.slice(m.indexOf(':') + 1));
  const line = (label, fam) => console.log(`${byFam[fam].length ? '✗' : '✓'} ${label}: ${byFam[fam].length ? 'falta ' + byFam[fam].join(', ') : 'listo'}`);
  line('Gamma (presentaciones)', 'presentation');
  line('Audio (OpenAI TTS + guion Anthropic server-side)', 'audio');
  line('Videogen (videos con IA)', 'video');
  console.log(`  OPENAI_TTS_MODEL: ${present(env, 'OPENAI_TTS_MODEL') ? env.OPENAI_TTS_MODEL : '(default del código)'} · OPENAI_TTS_VOICE: ${present(env, 'OPENAI_TTS_VOICE') ? env.OPENAI_TTS_VOICE : '(default del código)'}`);

  const worker = env.DYNAMIC_PROVIDER_WORKER_ENABLED;
  console.log(`${worker === 'true' ? '⚠️ ' : '✓'} DYNAMIC_PROVIDER_WORKER_ENABLED: ${worker === 'true' ? 'true (¡proveedores reales habilitados!)' : 'apagado'}`);
  console.log(`${present(env, 'FINOPS_INGEST_TOKEN') ? '✓' : '✗'} FINOPS_INGEST_TOKEN: ${present(env, 'FINOPS_INGEST_TOKEN') ? 'presente' : 'ausente'}`);

  if (present(env, 'DB_HOST') && present(env, 'DB_USER')) {
    const { Client } = require('pg');
    const client = new Client({
      host: env.DB_HOST,
      port: Number(env.DB_PORT || 5432),
      user: env.DB_USER,
      password: env.DB_PASS,
      database: env.DB_NAME,
      ssl: String(env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
    });
    try {
      await client.connect();
      console.log('── FinOps (SELECT) ──');
      const { rows } = await client.query(
        `select provider, count(*)::int n, count(*) filter (where verified)::int verified
           from public.pricing_catalog where effective_to is null group by provider order by provider`,
      );
      for (const r of rows) console.log(`  pricing_catalog ${r.provider}: ${r.n} filas vigentes, ${r.verified} verificadas`);
      const pol = await client.query(`select scope, count(*)::int n from public.cost_budget_policies group by scope order by scope`);
      console.log(`  cost_budget_policies: ${pol.rows.length ? pol.rows.map((r) => `${r.scope} ${r.n}`).join(', ') : 'ninguna (el gate responde ADMIN_APPROVAL: fail closed)'}`);
      const auth = await client.query(`select count(*)::int n from public.cost_budget_authorizations`);
      console.log(`  cost_budget_authorizations: ${auth.rows[0].n}`);
    } catch (err) {
      console.log(`⚠️  FinOps: no se pudo consultar (${String(err && err.code || err && err.message || err).slice(0, 80)})`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  // Solo si falta el tema claro por defecto (los temas legacy son todos oscuros): un GET por deploy como máximo.
  if (env.PREFLIGHT_GAMMA_THEMES === '1' && present(env, 'GAMMA_API_KEY') && !present(env, 'GAMMA_THEME_V21_LIGHT_DEFAULT')) {
    console.log('── Temas de Gamma (GET, no genera nada) ──');
    try {
      const res = await fetch('https://public-api.gamma.app/v1.0/themes', { headers: { 'X-API-KEY': env.GAMMA_API_KEY } });
      if (!res.ok) {
        console.log(`  GET /themes → HTTP ${res.status} (sin listado)`);
      } else {
        const body = await res.json();
        const list = Array.isArray(body) ? body : body.data || body.themes || body.items || [];
        for (const t of list.slice(0, 80)) {
          const id = t.id || t.themeId || '?';
          const name = t.name || t.title || '';
          const kind = t.colorScheme || t.mode || t.type || (t.isDark === true ? 'dark' : t.isDark === false ? 'light' : '');
          console.log(`  ${id} · ${name}${kind ? ' · ' + kind : ''}`);
        }
        console.log(`  (${list.length} temas)`);
      }
    } catch (err) {
      console.log(`  GET /themes falló: ${String(err && err.message || err).slice(0, 80)}`);
    }
  }
  console.log('✅ Preflight V2.1 de proveedores terminado (solo lectura, informativo).');
}

main().catch((err) => {
  console.log(`⚠️  preflight-v21-providers: ${String(err && err.message || err).slice(0, 160)}`);
});
