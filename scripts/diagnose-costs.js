#!/usr/bin/env node
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Load env
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq === -1) return;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1,-1);
    if (!(k in process.env)) process.env[k] = v;
  });
}

const client = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function run() {
  await client.connect();
  console.log('\n═══ QUERY 1: cost_rates para openai/elevenlabs ═══');
  const q1 = await client.query(`
    SELECT provider, service, model, unit_type, rate_usd, is_active
    FROM cost_rates
    WHERE provider IN ('openai_tts', 'openai', 'elevenlabs')
    ORDER BY provider, service, model
  `);
  console.table(q1.rows.length ? q1.rows : [{ result: 'SIN REGISTROS' }]);

  console.log('\n═══ QUERY 2: Todos los cost_rates (para ver qué hay) ═══');
  const q1b = await client.query(`
    SELECT provider, service, model, unit_type, rate_usd, is_active
    FROM cost_rates ORDER BY provider, service, model
  `);
  console.table(q1b.rows.length ? q1b.rows : [{ result: 'TABLA VACÍA' }]);

  console.log('\n═══ QUERY 3: Eventos de audio con detalle de costos ═══');
  const q2 = await client.query(`
    SELECT
      event_type, provider, model, cost_type, cost_source,
      estimated_cost_usd, real_cost_usd, units, unit_type,
      COUNT(*) AS cantidad
    FROM usage_events
    WHERE event_type IN ('welcome_audio_completed','audiobook_completed','audio_failed',
                         'welcome_audio_started','audiobook_started')
    GROUP BY event_type, provider, model, cost_type, cost_source,
             estimated_cost_usd, real_cost_usd, units, unit_type
    ORDER BY event_type, provider
  `);
  console.table(q2.rows.length ? q2.rows : [{ result: 'SIN EVENTOS DE AUDIO' }]);

  console.log('\n═══ QUERY 4: Costo total por proveedor (lógica del dashboard) ═══');
  const q3 = await client.query(`
    SELECT
      COALESCE(provider, ai_provider, 'otros') AS provider,
      COUNT(*) AS eventos,
      COALESCE(SUM(COALESCE(real_cost_usd, estimated_cost_usd,
        CASE WHEN cost_type = 'mock_zero' THEN 0 ELSE NULL END)), 0) AS cost_usd,
      COUNT(*) FILTER (WHERE cost_type = 'unknown') AS eventos_unknown,
      COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL AND real_cost_usd IS NULL) AS sin_costo
    FROM usage_events
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY COALESCE(provider, ai_provider, 'otros')
    ORDER BY cost_usd DESC
  `);
  console.table(q3.rows);

  console.log('\n═══ QUERY 5: Resumen cost_type (para entender el total $110.83) ═══');
  const q4 = await client.query(`
    SELECT
      cost_type,
      COUNT(*) AS eventos,
      SUM(COALESCE(estimated_cost_usd,0)) AS estimated_sum,
      SUM(COALESCE(real_cost_usd,0)) AS real_sum,
      SUM(COALESCE(real_cost_usd, estimated_cost_usd, 0)) AS total_efectivo
    FROM usage_events
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY cost_type ORDER BY total_efectivo DESC
  `);
  console.table(q4.rows);

  await client.end();
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
