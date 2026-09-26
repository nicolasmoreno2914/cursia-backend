#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — preflight de proveedores de STAGING (SOLO LECTURA, solo el .env de staging).
//
// Aislamiento: lee únicamente el .env del directorio actual (staging) y la DB de staging.
// Nunca lee el .env de producción, nunca copia claves y nunca imprime un valor secreto
// (ni fragmentos): solo READY / MISSING_CONFIG y los NOMBRES de lo que falta.
//
// Reporta:
//   Gamma      — GAMMA_API_KEY + un tema de Gamma para cada familia/modo (específico o default por modo)
//   OpenAI TTS — OPENAI_API_KEY (OPENAI_TTS_MODEL / OPENAI_TTS_VOICE opcionales: hay defaults)
//   Anthropic  — ANTHROPIC_API_KEY (guion del audiolibro server-side)
//   Videogen   — VIDEOGEN_API_KEY
//   YouTube    — YOUTUBE_CLIENT_ID / _SECRET / _REDIRECT_URI / _TOKEN_SECRET + canal conectado activo (DB)
//   FinOps     — FINOPS_INGEST_TOKEN + catálogo de precios vigente (DB); informa verificados y políticas
// y DYNAMIC_PROVIDER_WORKER_ENABLED (debe seguir en false hasta aprobar la calibración).
//
// Gamma theme discovery (read-only): con GAMMA_API_KEY y PREFLIGHT_GAMMA_THEMES=1, y solo si falta
// algún tema, GET /themes (no genera nada ni consume créditos) para elegir los ids.
//
// Informativo: nunca falla el deploy. Sale ≠ 0 solo si detecta el ref de PRODUCCIÓN.
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
const missingOf = (env, keys) => keys.filter((k) => !present(env, k));

/** Estado por proveedor a partir de la lista de faltantes (solo nombres). Pura: se testea. */
function providerStatus(env, db) {
  const R = require(path.resolve('dist/modules/dynamic-generation/provider-readiness.js'));
  const out = {};
  const gamma = missingOf(env, ['GAMMA_API_KEY']).concat(R.missingGammaThemes(env));
  out.Gamma = gamma;
  out['OpenAI TTS'] = missingOf(env, ['OPENAI_API_KEY']);
  out.Anthropic = missingOf(env, ['ANTHROPIC_API_KEY']);
  out.Videogen = missingOf(env, ['VIDEOGEN_API_KEY']);
  const yt = missingOf(env, ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REDIRECT_URI', 'YOUTUBE_TOKEN_SECRET']);
  if (db && db.youtubeActive === 0) yt.push('canal de YouTube conectado (youtube_connections activo)');
  out.YouTube = yt;
  const fin = missingOf(env, ['FINOPS_INGEST_TOKEN']);
  if (db && db.pricingRows === 0) fin.push('pricing_catalog vigente');
  out.FinOps = fin;
  // Coherencia con la verificación de startRun (providerReadinessMissing): mismo resultado para Gamma/audio/video.
  const sr = R.providerReadinessMissing({ providerModes: { presentation: 'real', audio: 'real' }, videoMode: 'real', videoCount: 1 }, env);
  return { status: out, startRunMissing: sr };
}

async function readDb(env) {
  if (!(present(env, 'DB_HOST') && present(env, 'DB_USER'))) return null;
  const { Client } = require('pg');
  const client = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
    ssl: String(env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  });
  const db = {};
  try {
    await client.connect();
    const pr = await client.query(
      `select provider, count(*)::int n, count(*) filter (where verified)::int verified
         from public.pricing_catalog where effective_to is null group by provider order by provider`,
    );
    db.pricing = pr.rows;
    db.pricingRows = pr.rows.reduce((a, r) => a + r.n, 0);
    db.policies = (await client.query(`select scope, count(*)::int n from public.cost_budget_policies group by scope order by scope`)).rows;
    db.globalPolicy = (await client.query(
      `select version, limits, on_exceed, require_human_approval_for_real_spend from public.cost_budget_policies
        where scope = 'global' order by version desc, created_at desc limit 1`,
    )).rows[0] || null;
    db.authorizations = (await client.query(`select count(*)::int n from public.cost_budget_authorizations`)).rows[0].n;
    db.youtubeActive = (await client.query(`select count(*)::int n from public.youtube_connections where status = 'active'`)).rows[0].n;
  } catch (err) {
    db.error = String((err && err.code) || (err && err.message) || err).slice(0, 80);
  } finally {
    await client.end().catch(() => {});
  }
  return db;
}

async function main() {
  if (process.env.MIGRATION_ENV !== 'staging') {
    console.error('❌ MIGRATION_ENV no es "staging" — este preflight es exclusivo de staging.');
    process.exit(1);
  }
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  const env = process.env;
  if (dbProjectRef(env) === KNOWN_PRODUCTION_SUPABASE_REF || String(env.SUPABASE_URL || '').includes(KNOWN_PRODUCTION_SUPABASE_REF)) {
    console.error('❌ La configuración apunta al proyecto de PRODUCCIÓN — preflight abortado (solo staging).');
    process.exit(1);
  }

  const db = await readDb(env);
  const { status } = providerStatus(env, db && !db.error ? db : null);
  console.log('── Proveedores de STAGING (READY / MISSING_CONFIG; solo nombres, nunca valores) ──');
  for (const [name, miss] of Object.entries(status)) {
    console.log(`${miss.length ? '✗' : '✓'} ${name}: ${miss.length ? 'MISSING_CONFIG — falta ' + miss.join(', ') : 'READY'}`);
  }
  if (db && db.error) console.log(`⚠️  DB de staging no consultable (${db.error}): YouTube/FinOps evaluados solo por variables`);
  console.log(`  TTS: modelo ${present(env, 'OPENAI_TTS_MODEL') ? 'configurado' : 'default del código'}, voz ${present(env, 'OPENAI_TTS_VOICE') ? 'configurada' : 'default del código'}`);
  const worker = env.DYNAMIC_PROVIDER_WORKER_ENABLED;
  console.log(`${worker === 'true' ? '⚠️ ' : '✓'} DYNAMIC_PROVIDER_WORKER_ENABLED: ${worker === 'true' ? 'ENCENDIDO (proveedores reales habilitados)' : 'apagado'}`);
  if (db && !db.error) {
    for (const r of db.pricing) console.log(`  pricing_catalog ${r.provider}: ${r.n} filas vigentes, ${r.verified} verificadas`);
    console.log(`  cost_budget_policies: ${db.policies.length ? db.policies.map((r) => `${r.scope} ${r.n}`).join(', ') : 'ninguna (el gate responde ADMIN_APPROVAL: fail closed)'}`);
    if (db.globalPolicy) {
      const g = db.globalPolicy;
      console.log(`  política global vigente v${g.version}: limits ${JSON.stringify(g.limits)} · on_exceed ${g.on_exceed} · aprobación humana ${g.require_human_approval_for_real_spend}`);
    }
    console.log(`  cost_budget_authorizations: ${db.authorizations}`);
  }

  if (env.PREFLIGHT_GAMMA_THEMES === '1' && present(env, 'GAMMA_API_KEY') && status.Gamma.some((m) => m.startsWith('GAMMA_THEME'))) {
    console.log('── Temas de Gamma disponibles (GET /themes: no genera nada ni consume créditos) ──');
    try {
      const res = await fetch('https://public-api.gamma.app/v1.0/themes', { headers: { 'X-API-KEY': env.GAMMA_API_KEY } });
      if (!res.ok) {
        console.log(`  GET /themes → HTTP ${res.status} (sin listado)`);
      } else {
        const body = await res.json();
        const list = Array.isArray(body) ? body : body.data || body.themes || body.items || [];
        for (const t of list.slice(0, 80)) {
          const kind = t.colorScheme || t.mode || t.type || (t.isDark === true ? 'dark' : t.isDark === false ? 'light' : '');
          console.log(`  ${t.id || t.themeId || '?'} · ${t.name || t.title || ''}${kind ? ' · ' + kind : ''}`);
        }
        console.log(`  (${list.length} temas)`);
      }
    } catch (err) {
      console.log(`  GET /themes falló: ${String((err && err.message) || err).slice(0, 80)}`);
    }
  }
  console.log('✅ Preflight V2.1 de proveedores terminado (solo staging, solo lectura, informativo).');
}

module.exports = { providerStatus };
if (require.main === module) {
  main().catch((err) => {
    console.log(`⚠️  preflight-v21-providers: ${String((err && err.message) || err).slice(0, 160)}`);
  });
}
